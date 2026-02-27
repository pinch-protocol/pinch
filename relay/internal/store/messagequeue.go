package store

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	queueBucket  = []byte("queue")
	ErrQueueFull = errors.New("message queue: recipient queue is full")
)

// QueueEntry represents a single queued message returned by FlushBatch.
type QueueEntry struct {
	Key        []byte
	Envelope   []byte
	SenderAddr string
}

// queuedMessage is the value stored in bbolt for each queued message.
type queuedMessage struct {
	EnqueuedAt int64  `json:"enqueued_at"` // Unix nanoseconds
	SenderAddr string `json:"sender_addr"`
	Envelope   []byte `json:"envelope"` // Raw serialized protobuf
}

// MessageQueue provides durable message queuing backed by bbolt.
// Messages are stored in per-recipient nested buckets with lexicographically
// ordered keys for chronological retrieval.
type MessageQueue struct {
	db            *bolt.DB
	maxPerAgent   int
	ttl           time.Duration
	sweepInterval time.Duration
}

// NewMessageQueue creates a MessageQueue using a shared bbolt database handle.
// The top-level "queue" bucket is created if it does not exist.
func NewMessageQueue(db *bolt.DB, maxPerAgent int, ttl time.Duration) (*MessageQueue, error) {
	err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(queueBucket)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &MessageQueue{
		db:            db,
		maxPerAgent:   maxPerAgent,
		ttl:           ttl,
		sweepInterval: 5 * time.Minute,
	}, nil
}

// encodeKey creates a 16-byte lexicographically sortable key from a
// nanosecond timestamp and a sequence number.
func encodeKey(timestampNanos int64, seq uint64) []byte {
	key := make([]byte, 16)
	binary.BigEndian.PutUint64(key[:8], uint64(timestampNanos))
	binary.BigEndian.PutUint64(key[8:], seq)
	return key
}

// Enqueue adds an encrypted envelope to the recipient's message queue.
// Returns ErrQueueFull if the recipient has reached the per-agent cap.
func (mq *MessageQueue) Enqueue(recipientAddr, senderAddr string, envelope []byte) error {
	return mq.db.Update(func(tx *bolt.Tx) error {
		root := tx.Bucket(queueBucket)
		sub, err := root.CreateBucketIfNotExists([]byte(recipientAddr))
		if err != nil {
			return err
		}

		// Check queue cap.
		if sub.Stats().KeyN >= mq.maxPerAgent {
			return ErrQueueFull
		}

		// Generate ordered key.
		now := time.Now().UnixNano()
		seq, _ := sub.NextSequence()
		key := encodeKey(now, seq)

		// Encode value.
		val, err := json.Marshal(queuedMessage{
			EnqueuedAt: now,
			SenderAddr: senderAddr,
			Envelope:   envelope,
		})
		if err != nil {
			return err
		}

		return sub.Put(key, val)
	})
}

// FlushBatch returns up to batchSize queued messages for the recipient
// in chronological order. Expired messages are skipped but not deleted
// (the sweep goroutine handles deletion). Returns an empty slice if no
// messages are queued.
func (mq *MessageQueue) FlushBatch(recipientAddr string, batchSize int) ([]QueueEntry, error) {
	var entries []QueueEntry
	err := mq.db.View(func(tx *bolt.Tx) error {
		root := tx.Bucket(queueBucket)
		if root == nil {
			return nil
		}
		sub := root.Bucket([]byte(recipientAddr))
		if sub == nil {
			return nil
		}

		now := time.Now().UnixNano()
		c := sub.Cursor()
		for k, v := c.First(); k != nil && len(entries) < batchSize; k, v = c.Next() {
			var msg queuedMessage
			if err := json.Unmarshal(v, &msg); err != nil {
				slog.Warn("skipping corrupt queue entry",
					"recipient", recipientAddr,
					"error", err)
				continue
			}
			// Skip expired messages.
			if now-msg.EnqueuedAt > mq.ttl.Nanoseconds() {
				continue
			}
			// Copy key bytes -- not valid after transaction.
			keyCopy := make([]byte, len(k))
			copy(keyCopy, k)
			entries = append(entries, QueueEntry{
				Key:        keyCopy,
				Envelope:   msg.Envelope,
				SenderAddr: msg.SenderAddr,
			})
		}
		return nil
	})
	return entries, err
}

// Remove deletes a specific message from the recipient's queue by key.
// No-op if the bucket or key does not exist.
func (mq *MessageQueue) Remove(recipientAddr string, key []byte) error {
	return mq.db.Update(func(tx *bolt.Tx) error {
		root := tx.Bucket(queueBucket)
		if root == nil {
			return nil
		}
		sub := root.Bucket([]byte(recipientAddr))
		if sub == nil {
			return nil
		}
		return sub.Delete(key)
	})
}

// Count returns the number of queued messages for the recipient.
// Returns 0 if no messages are queued.
func (mq *MessageQueue) Count(recipientAddr string) int {
	var count int
	if err := mq.db.View(func(tx *bolt.Tx) error {
		root := tx.Bucket(queueBucket)
		if root == nil {
			return nil
		}
		sub := root.Bucket([]byte(recipientAddr))
		if sub == nil {
			return nil
		}
		count = sub.Stats().KeyN
		return nil
	}); err != nil {
		return 0
	}
	return count
}

// Sweep iterates all per-recipient buckets and deletes expired messages
// using a two-pass collect-then-delete pattern to avoid bbolt cursor
// skip bugs. Returns the total count of cleaned messages.
func (mq *MessageQueue) Sweep() (int, error) {
	total := 0
	err := mq.db.Update(func(tx *bolt.Tx) error {
		root := tx.Bucket(queueBucket)
		if root == nil {
			return nil
		}

		now := time.Now().UnixNano()
		ttlNanos := mq.ttl.Nanoseconds()

		return root.ForEach(func(addr, _ []byte) error {
			sub := root.Bucket(addr)
			if sub == nil {
				return nil
			}

			// Pass 1: collect expired keys.
			var expired [][]byte
			if err := sub.ForEach(func(k, v []byte) error {
				var msg queuedMessage
				if err := json.Unmarshal(v, &msg); err != nil {
					// Collect corrupt entries for cleanup too.
					expired = append(expired, append([]byte{}, k...))
					return nil
				}
				if now-msg.EnqueuedAt > ttlNanos {
					expired = append(expired, append([]byte{}, k...))
				}
				return nil
			}); err != nil {
				return err
			}

			// Pass 2: delete collected keys.
			for _, k := range expired {
				if err := sub.Delete(k); err != nil {
					return err
				}
			}

			if len(expired) > 0 {
				slog.Info("Cleaned expired messages",
					"address", string(addr),
					"count", len(expired))
				total += len(expired)
			}
			return nil
		})
	})
	return total, err
}

// StartSweep runs a background goroutine that periodically sweeps
// expired messages. Stops when the context is cancelled.
func (mq *MessageQueue) StartSweep(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(mq.sweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if cleaned, err := mq.Sweep(); err != nil {
					slog.Error("sweep error", "error", err)
				} else if cleaned > 0 {
					slog.Info("sweep completed", "total_cleaned", cleaned)
				}
			}
		}
	}()
}
