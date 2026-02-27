# Phase 4: Store-and-Forward - Research

**Researched:** 2026-02-26
**Domain:** Relay-side message queuing with bbolt, TTL expiration, reconnect flush
**Confidence:** HIGH

## Summary

Phase 4 replaces the relay's in-memory 30-second pending message buffer (Phase 3 interim solution) with a durable bbolt-backed message queue that persists encrypted messages for offline agents with a 7-day default TTL. The relay already uses bbolt v1.4.3 for block storage (`relay/internal/store/blockstore.go`), so the new queue store shares the same database file via a separate bucket. The implementation is entirely relay-side Go code -- the TypeScript skill requires no changes beyond handling a new `was_stored` flag on delivery confirmations.

The core pattern is straightforward: when a recipient is offline, `RouteMessage` writes the serialized envelope to a bbolt bucket keyed by `<recipientAddress>/<timestampNanos>-<sequence>` for lexicographic ordering. When the recipient reconnects, the hub flushes queued messages in key order before allowing real-time traffic. A background goroutine sweeps expired messages periodically.

**Primary recommendation:** Create a new `MessageQueue` store in `relay/internal/store/` that shares the bbolt `*bolt.DB` with `BlockStore`, using a per-recipient nested bucket structure with big-endian timestamp keys for ordered retrieval.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Hard cap of 1,000 messages per agent (configurable via relay config flag)
- When queue is full, reject new messages with a clear error to the sender
- No silent eviction -- sender always knows if their message wasn't queued
- 7-day default TTL, global to all connections (configurable via relay config flag)
- Background sweep goroutine runs periodically to delete expired messages
- Sweep logs count of cleaned messages per agent (e.g. "Cleaned 12 expired messages for pinch:abc123")
- No per-connection TTL override in v1
- Batched flush (e.g. 50 messages at a time) after authentication completes
- Flush completes before real-time messages flow -- queued messages first, then live traffic
- Messages only removed from queue after delivery confirmation -- if agent disconnects mid-flush, remaining messages stay queued for next reconnect
- Relay sends pending message count to agent before starting flush (agent/skill can prepare)
- No "queued" acknowledgment -- sender waits for actual E2E delivery confirmation (fires when recipient reconnects and receives the message)
- No notification when messages expire from queue (silent expiry)
- Individual delivery confirmations per stored message (consistent with live delivery behavior)
- Delivery confirmation includes a `was_stored` flag so sender knows the message was queued and delivered later (vs real-time)

### Claude's Discretion
- Background sweep interval (e.g. 5 min, 10 min)
- Batch size for flush (around 50 but tunable)
- bbolt bucket structure and key design
- Delay between flush batches
- Error handling for corrupt queue entries

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RELY-05 | Relay queues encrypted messages in bbolt for offline agents with configurable TTL (7-day default) | bbolt MessageQueue store with per-recipient nested buckets, big-endian nanosecond timestamp keys, TTL stored per message, background sweep goroutine |
| RELY-06 | Relay flushes queued messages to agent on reconnection in order | Cursor-based ordered iteration over nested bucket, batched flush (50 at a time) after auth completes but before real-time traffic, messages removed only after delivery confirmation |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| go.etcd.io/bbolt | v1.4.3 | Durable message queue persistence | Already in use for BlockStore; single-file embedded KV with lexicographic cursor ordering |
| google.golang.org/protobuf | (existing) | Proto schema for new message types | Already used for all wire messages |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| encoding/binary | stdlib | Big-endian uint64 keys for ordered message storage | Key encoding for bbolt cursor ordering |
| log/slog | stdlib | Structured logging for sweep and flush operations | Already used throughout relay |
| time | stdlib | TTL calculation, sweep ticker | Background goroutine timing |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| bbolt nested buckets (per-recipient) | Single flat bucket with composite keys | Nested buckets are cleaner for per-recipient operations (count, flush, delete-all) but slightly more complex init; flat keys require prefix scanning. Nested buckets win for this use case. |
| Big-endian nanosecond timestamp keys | UUIDv7 keys | UUIDv7 has lexicographic ordering but is 16 bytes vs 8+8 for timestamp+sequence. Timestamp+sequence is simpler and sufficient. |
| Background sweep goroutine | Lazy deletion on read | Lazy deletion doesn't bound disk usage; background sweep is the standard pattern for TTL stores |

**Installation:**
No new dependencies required -- bbolt v1.4.3 and all protobuf tooling already in `relay/go.mod`.

## Architecture Patterns

### Recommended Project Structure
```
relay/internal/store/
├── blockstore.go        # Existing -- block relationships
├── blockstore_test.go   # Existing -- block tests
├── db.go                # NEW -- shared *bolt.DB opener, returns DB handle
├── messagequeue.go      # NEW -- message queue store
└── messagequeue_test.go # NEW -- queue tests
```

### Pattern 1: Shared Database, Separate Buckets
**What:** Extract `bolt.Open()` from `BlockStore` into a shared `db.go` that returns a `*bolt.DB`. Both `BlockStore` and `MessageQueue` receive the shared handle.
**When to use:** When multiple stores need the same bbolt file (bbolt enforces single-process file lock).
**Why:** The current `BlockStore.NewBlockStore()` calls `bolt.Open()` directly. Opening the same file twice would hang (bbolt exclusive lock). Extracting DB creation lets both stores share one handle.

```go
// relay/internal/store/db.go
package store

import bolt "go.etcd.io/bbolt"

// OpenDB opens the shared bbolt database for all relay stores.
func OpenDB(path string) (*bolt.DB, error) {
    return bolt.Open(path, 0600, nil)
}
```

```go
// BlockStore accepts *bolt.DB instead of opening its own
func NewBlockStore(db *bolt.DB) (*BlockStore, error) {
    err := db.Update(func(tx *bolt.Tx) error {
        _, err := tx.CreateBucketIfNotExists(blocksBucket)
        return err
    })
    if err != nil {
        return nil, err
    }
    return &BlockStore{db: db}, nil
}
```

### Pattern 2: Per-Recipient Nested Bucket with Ordered Keys
**What:** Top-level "queue" bucket contains nested sub-buckets keyed by recipient address. Within each sub-bucket, messages are keyed by `<big-endian-nanos><big-endian-sequence>` (16 bytes total) for lexicographic ordering.
**When to use:** When you need per-recipient isolation (count, flush, TTL sweep) with ordered iteration.

```go
// Bucket structure:
// "queue" (top-level)
//   └── "pinch:abc123@relay" (nested, per-recipient)
//         ├── [8-byte-timestamp-nanos][8-byte-seq] -> msgValue
//         ├── [8-byte-timestamp-nanos][8-byte-seq] -> msgValue
//         └── ...

var queueBucket = []byte("queue")

// encodeKey creates a 16-byte lexicographically sortable key.
func encodeKey(timestampNanos int64, seq uint64) []byte {
    key := make([]byte, 16)
    binary.BigEndian.PutUint64(key[:8], uint64(timestampNanos))
    binary.BigEndian.PutUint64(key[8:], seq)
    return key
}
```

### Pattern 3: Message Value Encoding
**What:** Each queued message value stores the raw envelope bytes plus metadata (enqueue timestamp for TTL, sender address for error reporting).
**When to use:** Every enqueue operation.

```go
// queuedMessage is the value stored in bbolt for each queued message.
type queuedMessage struct {
    EnqueuedAt int64  // Unix nanoseconds -- for TTL expiration
    SenderAddr string // For error responses if queue is full
    Envelope   []byte // Raw serialized protobuf envelope (opaque)
}
```

Use `encoding/gob` or a simple binary format. Since the relay already imports protobuf, a lightweight approach is to define a small proto message for queue metadata, or use `encoding/json` for simplicity (the values are small and write throughput is bounded by bbolt's single-writer constraint anyway).

**Recommendation:** Use `encoding/json` for the queue value format. It is human-debuggable with `bbolt` CLI tool, the values are small (~64KB max envelope + tiny metadata), and the write path is already serialized by bbolt.

### Pattern 4: Two-Phase Flush with Delivery Confirmation
**What:** On reconnect, the hub reads all queued messages via cursor, sends them in batches of 50, but does NOT delete them from bbolt until the delivery confirmation comes back from the recipient. This ensures no message loss during mid-flush disconnects.
**When to use:** Every reconnection event.

```
1. Agent reconnects, auth succeeds
2. Hub checks MessageQueue.Count(address)
3. If count > 0: send QueueStatus(pendingCount) to agent
4. Read messages via cursor in order, send in batches of 50
5. For each batch: send messages, wait for delivery confirmations
6. On each confirmation: delete that message from queue
7. If agent disconnects mid-flush: remaining messages stay queued
8. After all queued messages flushed: allow real-time traffic
```

### Pattern 5: Background TTL Sweep
**What:** A goroutine with a `time.Ticker` periodically iterates all per-recipient buckets and removes expired messages using the two-pass collect-then-delete pattern (bbolt cursor.Delete can skip keys).
**When to use:** Runs continuously while relay is up.

```go
// Sweep pattern -- two-pass to avoid cursor skip bug
func (mq *MessageQueue) Sweep() {
    mq.db.Update(func(tx *bolt.Tx) error {
        root := tx.Bucket(queueBucket)
        if root == nil { return nil }

        now := time.Now().UnixNano()
        root.ForEach(func(addr, _ []byte) error {
            sub := root.Bucket(addr)
            if sub == nil { return nil }

            // Pass 1: collect expired keys
            var expired [][]byte
            sub.ForEach(func(k, v []byte) error {
                var msg queuedMessage
                json.Unmarshal(v, &msg)
                if now - msg.EnqueuedAt > ttlNanos {
                    expired = append(expired, k)
                }
                return nil
            })

            // Pass 2: delete collected keys
            for _, k := range expired {
                sub.Delete(k)
            }

            // Log if any cleaned
            if len(expired) > 0 {
                slog.Info("Cleaned expired messages",
                    "address", string(addr),
                    "count", len(expired))
            }
            return nil
        })
        return nil
    })
}
```

**Recommended sweep interval:** 5 minutes. With a 7-day TTL, 5-minute granularity is negligible. Shorter intervals waste write transactions; longer intervals accumulate more dead data.

### Anti-Patterns to Avoid
- **Opening bbolt twice for the same file:** bbolt uses an exclusive file lock. The second `bolt.Open()` on the same path will hang indefinitely. Extract DB creation into a shared function.
- **Deleting keys during cursor iteration without two-pass:** bbolt `cursor.Delete()` can cause the cursor to skip the next key. Always collect keys first, then delete in a second pass.
- **Storing queue in memory with periodic snapshots:** Loses messages on relay crash. bbolt provides crash-safe durability via its write-ahead approach -- use it.
- **Flushing all messages in one giant batch:** Can overwhelm the agent's receive buffer. Batch at 50 messages with small delays between batches.
- **Deleting queued messages on send (before confirmation):** If agent disconnects mid-flush, messages are lost. Delete only on delivery confirmation receipt.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Ordered message storage | Custom file-based WAL | bbolt nested buckets with big-endian keys | bbolt handles crash recovery, compaction, concurrent reads |
| TTL expiration | Per-message timer goroutines | Background sweep with time.Ticker | Timer-per-message doesn't scale; single sweep is O(n) and runs infrequently |
| Message ordering | Application-level sorting | bbolt lexicographic key ordering | Keys are byte-sorted by B+ tree -- zero application code needed for ordering |
| Crash-safe writes | Manual fsync/journaling | bbolt Update transactions | bbolt provides ACID transactions with crash recovery built in |

**Key insight:** bbolt's lexicographic key ordering eliminates the need for any sorting logic. Big-endian nanosecond timestamps as keys produce correct chronological order automatically. The relay writes once and reads in order -- exactly what bbolt's B+ tree is optimized for.

## Common Pitfalls

### Pitfall 1: bbolt File Lock Hang
**What goes wrong:** Opening the same bbolt file from two places (e.g., BlockStore and MessageQueue each calling `bolt.Open()`) causes the second caller to hang indefinitely.
**Why it happens:** bbolt uses an exclusive file lock (`flock`). Only one `*bolt.DB` handle can exist per file per process.
**How to avoid:** Extract `bolt.Open()` into a shared `OpenDB()` function. Pass the `*bolt.DB` to both `BlockStore` and `MessageQueue`.
**Warning signs:** Relay startup hangs after "opening block store" log line.

### Pitfall 2: Cursor Delete Skipping Keys
**What goes wrong:** Calling `cursor.Delete()` during `ForEach` or cursor iteration causes the cursor to advance, then `Next()` advances again, skipping a key.
**Why it happens:** bbolt cursor internals reposition after delete.
**How to avoid:** Two-pass approach: collect keys to delete in pass 1, delete in pass 2.
**Warning signs:** TTL sweep misses some expired messages; queue slowly grows despite sweep running.

### Pitfall 3: Flush Before Registration
**What goes wrong:** Queued messages are flushed to the client before the client is fully registered in the hub, causing real-time messages to arrive before queued ones.
**Why it happens:** Race between registration and flush ordering.
**How to avoid:** The current hub `Run()` loop already flushes pending messages inside the registration handler. The new bbolt-based flush should follow the same pattern: flush inside `register` case, before the client is visible for real-time routing.
**Warning signs:** Messages arrive out of order -- recent real-time messages before older queued ones.

### Pitfall 4: Queue Full Error Without Sender Feedback
**What goes wrong:** Queue hits the 1,000-message cap but the sender gets no indication the message wasn't stored.
**Why it happens:** The current `RouteMessage` silently drops undeliverable messages.
**How to avoid:** When the queue is full, send an error envelope back to the sender. Define a new `MESSAGE_TYPE_QUEUE_FULL` or reuse an error mechanism. The user's decision explicitly states "sender always knows if their message wasn't queued" and "no silent eviction."
**Warning signs:** Sender shows "sent" but message never arrives; no error in sender logs.

### Pitfall 5: Delivery Confirmation for Queued Messages Not Reaching Sender
**What goes wrong:** Agent B reconnects, receives queued messages, sends delivery confirmations back to Agent A, but Agent A is now offline -- the delivery confirmation is lost.
**Why it happens:** Delivery confirmations are themselves messages routed through the hub. If Agent A is offline when the confirmation is sent, it goes to... the queue. This creates a recursive dependency.
**How to avoid:** Delivery confirmations should also be queued for offline recipients. This is actually already the case with the current architecture since `RouteMessage` handles all message types. The `was_stored` flag on the confirmation tells the sender it was delayed.
**Warning signs:** Outbound messages stuck in "sent" state forever because confirmation was lost.

### Pitfall 6: Removing In-Memory Pending Buffer Too Early
**What goes wrong:** Removing the Phase 3 in-memory pending buffer before the bbolt queue is fully working leaves a gap where offline messages are lost.
**Why it happens:** Phased migration without overlap.
**How to avoid:** Build the bbolt queue, wire it into `RouteMessage`, and only then remove the in-memory `pendingMessages` map. Do not remove the old code until the new code is tested.
**Warning signs:** Messages for briefly-offline agents disappear.

## Code Examples

### Enqueue a Message
```go
// Source: bbolt official docs pattern adapted for Pinch
func (mq *MessageQueue) Enqueue(recipientAddr string, senderAddr string, envelope []byte) error {
    return mq.db.Update(func(tx *bolt.Tx) error {
        root := tx.Bucket(queueBucket)
        sub, err := root.CreateBucketIfNotExists([]byte(recipientAddr))
        if err != nil {
            return err
        }

        // Check queue cap
        stats := sub.Stats()
        if stats.KeyN >= mq.maxPerAgent {
            return ErrQueueFull
        }

        // Generate ordered key
        seq, _ := sub.NextSequence()
        key := encodeKey(time.Now().UnixNano(), seq)

        // Encode value
        val, _ := json.Marshal(queuedMessage{
            EnqueuedAt: time.Now().UnixNano(),
            SenderAddr: senderAddr,
            Envelope:   envelope,
        })

        return sub.Put(key, val)
    })
}
```

### Flush Queued Messages (Batched)
```go
// Source: bbolt cursor pattern from official docs
func (mq *MessageQueue) FlushBatch(recipientAddr string, batchSize int) ([]QueueEntry, error) {
    var entries []QueueEntry
    mq.db.View(func(tx *bolt.Tx) error {
        root := tx.Bucket(queueBucket)
        sub := root.Bucket([]byte(recipientAddr))
        if sub == nil {
            return nil
        }
        c := sub.Cursor()
        for k, v := c.First(); k != nil && len(entries) < batchSize; k, v = c.Next() {
            var msg queuedMessage
            if err := json.Unmarshal(v, &msg); err != nil {
                continue // Skip corrupt entries
            }
            // Skip expired (don't delete here -- sweep handles that)
            if time.Now().UnixNano()-msg.EnqueuedAt > mq.ttlNanos {
                continue
            }
            entries = append(entries, QueueEntry{
                Key:      append([]byte{}, k...), // Copy key (not valid after tx)
                Envelope: msg.Envelope,
            })
        }
        return nil
    })
    return entries, nil
}
```

### Delete After Delivery Confirmation
```go
// Source: bbolt Delete pattern
func (mq *MessageQueue) Remove(recipientAddr string, key []byte) error {
    return mq.db.Update(func(tx *bolt.Tx) error {
        root := tx.Bucket(queueBucket)
        sub := root.Bucket([]byte(recipientAddr))
        if sub == nil {
            return nil
        }
        return sub.Delete(key)
    })
}
```

### Count Pending Messages
```go
// Source: bbolt Stats pattern
func (mq *MessageQueue) Count(recipientAddr string) int {
    var count int
    mq.db.View(func(tx *bolt.Tx) error {
        root := tx.Bucket(queueBucket)
        if root == nil { return nil }
        sub := root.Bucket([]byte(recipientAddr))
        if sub == nil { return nil }
        count = sub.Stats().KeyN
        return nil
    })
    return count
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| In-memory pending buffer (30s TTL) | bbolt persistent queue (7-day TTL) | Phase 4 (this phase) | Messages survive relay restarts; offline agents get all missed messages |
| BlockStore opens its own bolt.DB | Shared bolt.DB handle across stores | Phase 4 (this phase) | Required architectural change to avoid file lock hang |
| No sender feedback on queue full | Error envelope back to sender | Phase 4 (this phase) | Sender knows if message wasn't queued |

**Deprecated/outdated:**
- Phase 3's `pendingMessages map[string][]pendingMsg` in hub.go: Will be replaced by bbolt MessageQueue. Remove after new queue is verified working.

## Proto Schema Changes Required

The following additions to `proto/pinch/v1/envelope.proto` are needed:

1. **Add `was_stored` to `DeliveryConfirm`:** `bool was_stored = 5;` -- Tells sender the message was queued and delivered later vs real-time.

2. **Add `MESSAGE_TYPE_QUEUE_STATUS` to `MessageType` enum:** New message type for the relay to inform the agent of pending message count before flush.

3. **Add `QueueStatus` message:** Sent by relay to agent after auth, before flush begins.
```protobuf
message QueueStatus {
    int32 pending_count = 1;
}
```

4. **Add `MESSAGE_TYPE_QUEUE_FULL` to `MessageType` enum:** Error response sent back to sender when recipient's queue is full.

5. **Add `QueueFull` message:** Error message with details.
```protobuf
message QueueFull {
    string recipient_address = 1;
    string reason = 2;
}
```

6. **Add these to Envelope's oneof:** `QueueStatus queue_status = 22;` and `QueueFull queue_full = 23;`

## Hub Integration Points

The hub needs these modifications:

1. **`NewHub` signature change:** Accept `*MessageQueue` in addition to `*BlockStore`.

2. **`RouteMessage` modification:** When recipient is offline:
   - Call `mq.Enqueue()` instead of appending to in-memory map
   - If `ErrQueueFull` returned, send `QueueFull` error envelope back to sender
   - Remove the in-memory `pendingMessages` map entirely

3. **`Run` registration handler:** When a client registers:
   - Check `mq.Count(address)` for pending messages
   - If count > 0: send `QueueStatus` envelope with pending count
   - Start batched flush goroutine (50 messages per batch)
   - Block real-time message delivery to this client until flush completes

4. **Flush-to-confirmation tracking:** Need a mechanism to correlate delivery confirmations for flushed messages with their bbolt keys so they can be deleted. Options:
   - Store the bbolt key in the envelope's `message_id` field (but this is already the UUIDv7 message ID)
   - Maintain an in-memory map of `messageId -> bboltKey` during flush (preferred -- scoped to flush lifetime)
   - Use the `message_id` from the envelope to look up the queue entry (requires a secondary index or scan)

   **Recommendation:** During flush, maintain a temporary `map[string][]byte` mapping `messageId -> bboltKey`. When delivery confirmation arrives for a flushed message, look up the bbolt key and call `mq.Remove()`. If the client disconnects, discard the map -- messages remain in bbolt for next reconnect.

## Open Questions

1. **Flush blocking mechanism**
   - What we know: Flush must complete before real-time messages flow. The current `register` case in `Run()` handles pending flush synchronously within the channel receive.
   - What's unclear: With batched flush (50 at a time) requiring delivery confirmations between batches, the flush can't be fully synchronous -- it spans multiple message round-trips.
   - Recommendation: Use a "flushing" flag on the Client. While flushing=true, `RouteMessage` enqueues to bbolt instead of `client.Send()`. The flush goroutine reads batches and sends them. When all flushed, set flushing=false and real-time traffic flows. This avoids blocking the hub's single event loop.

2. **Delivery confirmation correlation during flush**
   - What we know: Each flushed message gets a delivery confirmation back. We need to match confirmation to bbolt key for deletion.
   - What's unclear: The envelope already has a `message_id` field (UUIDv7 set by sender). Can we use this to correlate?
   - Recommendation: Yes -- during flush, build a `map[string][]byte` of `messageId (from envelope) -> bboltKey`. When `DELIVERY_CONFIRM` arrives with matching `message_id`, look up and delete. The map is scoped to the flush session.

3. **Concurrent flush and real-time for same recipient**
   - What we know: User decided "flush completes before real-time messages flow."
   - What's unclear: If Agent B reconnects and Agent A sends a new real-time message during flush, should it queue or wait?
   - Recommendation: During flush, all new inbound messages for the flushing client go to bbolt queue (appended after existing messages). This maintains strict ordering. When flush completes, the client transitions to real-time mode.

## Sources

### Primary (HIGH confidence)
- [bbolt official Go docs (pkg.go.dev)](https://pkg.go.dev/go.etcd.io/bbolt) - API reference for Bucket, Cursor, Transaction patterns, NextSequence, key size limits
- [bbolt GitHub repository](https://github.com/etcd-io/bbolt) - README with usage patterns, nested buckets, ForEach, cursor iteration
- Existing codebase: `relay/internal/store/blockstore.go` - Established bbolt patterns in this project
- Existing codebase: `relay/internal/hub/hub.go` - Current pending message buffer, RouteMessage flow, registration handler

### Secondary (MEDIUM confidence)
- [boltdb/bolt issue #541](https://github.com/boltdb/bolt/issues/541) - Confirmed bbolt has no native TTL; application-level sweep required
- [boltdb/bolt issue #362](https://github.com/boltdb/bolt/issues/362) - Confirmed cursor.Delete() skip behavior; two-pass pattern required
- [bbolt cursor documentation](https://deepwiki.com/castermode/read-code-bbolt.v1.3.6/2.4-cursors-and-iteration) - Cursor internals and iteration patterns

### Tertiary (LOW confidence)
- None -- all findings verified with official sources or existing codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - bbolt v1.4.3 already in use; no new dependencies
- Architecture: HIGH - Patterns derived from existing codebase + official bbolt docs
- Pitfalls: HIGH - Cursor delete bug and file lock issue are well-documented; flush ordering directly observable in current code

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (stable -- bbolt and Go stdlib are mature)
