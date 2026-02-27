// Package hub implements a hub-and-spoke WebSocket connection manager.
// The Hub goroutine maintains a routing table mapping pinch: addresses
// to active WebSocket connections, with channels for registration and
// unregistration of clients.
package hub

import (
	"context"
	"log/slog"
	"sync"
	"time"

	pinchv1 "github.com/pinch-protocol/pinch/gen/go/pinch/v1"
	"github.com/pinch-protocol/pinch/relay/internal/store"
	"google.golang.org/protobuf/proto"
)

const (
	// maxEnvelopeSize is the maximum allowed size in bytes for an incoming
	// protobuf envelope. Envelopes exceeding this limit are silently dropped
	// to prevent abuse.
	maxEnvelopeSize = 65536

	// flushBatchSize is the number of queued messages sent per batch
	// during reconnect flush.
	flushBatchSize = 50

	// flushBatchDelay is the pause between flush batches to avoid
	// overwhelming the client's receive buffer.
	flushBatchDelay = 10 * time.Millisecond
)

// Hub maintains the set of active clients and routes messages between them.
// A single Hub goroutine serializes access to the routing table via channels.
type Hub struct {
	// clients maps pinch: addresses to active Client connections.
	clients map[string]*Client

	// register receives clients to add to the routing table.
	register chan *Client

	// unregister receives clients to remove from the routing table.
	unregister chan *Client

	// blockStore persists block relationships. Can be nil for tests that
	// don't need blocking.
	blockStore *store.BlockStore

	// mq is the durable message queue for offline recipients. Can be nil
	// for tests that don't need store-and-forward.
	mq *store.MessageQueue

	// rateLimiter enforces per-connection token bucket rate limiting.
	// Can be nil to disable rate limiting (e.g., tests).
	rateLimiter *RateLimiter

	// mu protects external reads of the routing table.
	mu sync.RWMutex
}

// NewHub creates a new Hub with initialized channels and routing table.
// blockStore may be nil if block enforcement is not needed (e.g., tests).
// mq may be nil if store-and-forward is not needed (e.g., tests).
// rl may be nil to disable rate limiting (e.g., tests).
func NewHub(blockStore *store.BlockStore, mq *store.MessageQueue, rl *RateLimiter) *Hub {
	return &Hub{
		clients:     make(map[string]*Client),
		register:    make(chan *Client),
		unregister:  make(chan *Client),
		blockStore:  blockStore,
		mq:          mq,
		rateLimiter: rl,
	}
}

// Run starts the hub's main event loop. It processes register and unregister
// events until the context is cancelled. Run should be called in its own
// goroutine.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.address] = client
			h.mu.Unlock()

			// Check for queued messages and start flush if needed.
			if h.mq != nil {
				count := h.mq.Count(client.address)
				if count > 0 {
					// Send QueueStatus to inform the client of pending messages.
					h.sendQueueStatus(client, int32(count))
					client.SetFlushing(true)
					go h.flushQueuedMessages(client)
				}
			}

			slog.Info("client registered",
				"address", client.address,
				"connections", h.ClientCount(),
			)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.address]; ok {
				delete(h.clients, client.address)
				close(client.send)
				client.cancel()
			}
			h.mu.Unlock()
			if h.rateLimiter != nil {
				h.rateLimiter.Remove(client.address)
			}
			slog.Info("client unregistered",
				"address", client.address,
				"connections", h.ClientCount(),
			)

		case <-ctx.Done():
			h.mu.Lock()
			for addr, client := range h.clients {
				close(client.send)
				client.cancel()
				delete(h.clients, addr)
			}
			h.mu.Unlock()
			slog.Info("hub stopped")
			return
		}
	}
}

// sendQueueStatus sends a QueueStatus envelope to the client informing
// it of the number of pending queued messages.
func (h *Hub) sendQueueStatus(client *Client, pendingCount int32) {
	env := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_QUEUE_STATUS,
		Payload: &pinchv1.Envelope_QueueStatus{
			QueueStatus: &pinchv1.QueueStatus{
				PendingCount: pendingCount,
			},
		},
	}
	data, err := proto.Marshal(env)
	if err != nil {
		slog.Error("failed to marshal QueueStatus", "error", err)
		return
	}
	client.Send(data)
}

// flushQueuedMessages drains all queued messages for the client in batches.
// After flush completes, the client's flushing flag is cleared and real-time
// traffic can resume. If the client disconnects during flush, remaining
// messages stay in bbolt for the next reconnect.
//
// Each entry is deleted from bbolt immediately after being sent to the client's
// send buffer. This prevents duplicate delivery when the flush loop re-reads
// the queue. Messages that arrive DURING flush (enqueued by RouteMessage) will
// be picked up in subsequent FlushBatch calls.
func (h *Hub) flushQueuedMessages(client *Client) {
	defer client.SetFlushing(false)

	for {
		// Check if client disconnected.
		if client.ctx.Err() != nil {
			slog.Info("flush aborted: client disconnected",
				"address", client.address,
			)
			return
		}

		entries, err := h.mq.FlushBatch(client.address, flushBatchSize)
		if err != nil {
			slog.Error("flush batch error",
				"address", client.address,
				"error", err,
			)
			return
		}

		if len(entries) == 0 {
			// All queued messages have been sent.
			slog.Info("flush complete",
				"address", client.address,
			)
			return
		}

		for _, entry := range entries {
			client.Send(entry.Envelope)
			// Delete entry from bbolt immediately after queuing to send buffer.
			// This prevents duplicate delivery on the next FlushBatch call.
			if err := h.mq.Remove(client.address, entry.Key); err != nil {
				slog.Error("failed to remove flushed entry",
					"address", client.address,
					"error", err,
				)
			}
		}

		// Small delay between batches to avoid overwhelming the client.
		time.Sleep(flushBatchDelay)
	}
}

// ClientCount returns the number of currently connected clients.
// It is safe for concurrent use.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// LookupClient returns the client registered with the given address.
// Returns the client and true if found, or nil and false otherwise.
// It is safe for concurrent use.
func (h *Hub) LookupClient(address string) (*Client, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[address]
	return c, ok
}

// Register queues a client for registration with the hub.
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister queues a client for removal from the hub.
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

// RouteMessage deserializes an envelope, handles block/unblock commands,
// checks blocks, and delivers the message to the recipient.
// Blocked and undeliverable messages are silently dropped.
// Envelopes exceeding 64KB are silently dropped.
func (h *Hub) RouteMessage(from *Client, envelope []byte) error {
	// Enforce per-connection rate limit.
	if h.rateLimiter != nil && !h.rateLimiter.Allow(from.Address()) {
		h.sendRateLimited(from)
		return nil
	}

	// Enforce maximum envelope size.
	if len(envelope) > maxEnvelopeSize {
		slog.Debug("route: envelope exceeds max size",
			"from", from.Address(),
			"size", len(envelope),
			"max", maxEnvelopeSize,
		)
		return nil
	}

	var env pinchv1.Envelope
	if err := proto.Unmarshal(envelope, &env); err != nil {
		slog.Debug("route: invalid protobuf",
			"from", from.Address(),
			"error", err,
		)
		return err
	}

	switch env.Type {
	case pinchv1.MessageType_MESSAGE_TYPE_BLOCK_NOTIFICATION:
		bn := env.GetBlockNotification()
		if bn == nil {
			return nil
		}
		if h.blockStore != nil {
			// Blocker is the authenticated sender -- ignore blocker_address
			// field in payload and use the verified address.
			return h.blockStore.Block(from.Address(), bn.BlockedAddress)
		}
		return nil

	case pinchv1.MessageType_MESSAGE_TYPE_UNBLOCK_NOTIFICATION:
		un := env.GetUnblockNotification()
		if un == nil {
			return nil
		}
		if h.blockStore != nil {
			return h.blockStore.Unblock(from.Address(), un.UnblockedAddress)
		}
		return nil
	}

	// For all other message types: check block list before delivery.
	toAddress := env.ToAddress
	if toAddress == "" {
		return nil
	}

	if h.blockStore != nil && h.blockStore.IsBlocked(toAddress, from.Address()) {
		// Silent drop -- no error to sender.
		slog.Debug("route: message blocked",
			"from", from.Address(),
			"to", toAddress,
		)
		return nil
	}

	recipient, ok := h.LookupClient(toAddress)
	if !ok {
		// Recipient offline -- enqueue to durable store.
		if h.mq != nil {
			err := h.mq.Enqueue(toAddress, from.Address(), envelope)
			if err == store.ErrQueueFull {
				h.sendQueueFull(from, toAddress)
				slog.Info("queue full for recipient",
					"from", from.Address(),
					"to", toAddress,
				)
			} else if err != nil {
				slog.Error("failed to enqueue message",
					"from", from.Address(),
					"to", toAddress,
					"error", err,
				)
			}
		}
		return nil
	}

	// If recipient is online but flushing, enqueue to preserve ordering.
	if recipient.IsFlushing() {
		if h.mq != nil {
			err := h.mq.Enqueue(toAddress, from.Address(), envelope)
			if err == store.ErrQueueFull {
				h.sendQueueFull(from, toAddress)
			} else if err != nil {
				slog.Error("failed to enqueue message during flush",
					"from", from.Address(),
					"to", toAddress,
					"error", err,
				)
			}
		}
		return nil
	}

	recipient.Send(envelope)
	return nil
}

// sendRateLimited sends a RateLimited error envelope to the sender.
func (h *Hub) sendRateLimited(client *Client) {
	env := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_RATE_LIMITED,
		Payload: &pinchv1.Envelope_RateLimited{
			RateLimited: &pinchv1.RateLimited{
				RetryAfterMs: 1000,
				Reason:       "per-connection rate limit exceeded",
			},
		},
	}
	data, err := proto.Marshal(env)
	if err != nil {
		slog.Error("failed to marshal RateLimited", "error", err)
		return
	}
	client.Send(data)
}

// sendQueueFull sends a QueueFull error envelope to the sender.
func (h *Hub) sendQueueFull(sender *Client, recipientAddress string) {
	env := &pinchv1.Envelope{
		Version: 1,
		Type:    pinchv1.MessageType_MESSAGE_TYPE_QUEUE_FULL,
		Payload: &pinchv1.Envelope_QueueFull{
			QueueFull: &pinchv1.QueueFull{
				RecipientAddress: recipientAddress,
				Reason:           "recipient message queue is full (limit: 1000)",
			},
		},
	}
	data, err := proto.Marshal(env)
	if err != nil {
		slog.Error("failed to marshal QueueFull", "error", err)
		return
	}
	sender.Send(data)
}
