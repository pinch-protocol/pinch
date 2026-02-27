# Phase 4: Store-and-Forward - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Relay-side message queuing for offline agents. When a recipient is disconnected, the relay persists encrypted messages in bbolt and flushes them in order on reconnect. No new user-facing capabilities — this is infrastructure that makes existing messaging reliable across disconnections.

</domain>

<decisions>
## Implementation Decisions

### Queue limits and backpressure
- Hard cap of 1,000 messages per agent (configurable via relay config flag)
- When queue is full, reject new messages with a clear error to the sender
- No silent eviction — sender always knows if their message wasn't queued

### TTL and expiration
- 7-day default TTL, global to all connections (configurable via relay config flag)
- Background sweep goroutine runs periodically to delete expired messages
- Sweep logs count of cleaned messages per agent (e.g. "Cleaned 12 expired messages for pinch:abc123")
- No per-connection TTL override in v1

### Flush and reconnect behavior
- Batched flush (e.g. 50 messages at a time) after authentication completes
- Flush completes before real-time messages flow — queued messages first, then live traffic
- Messages only removed from queue after delivery confirmation — if agent disconnects mid-flush, remaining messages stay queued for next reconnect
- Relay sends pending message count to agent before starting flush (agent/skill can prepare)

### Sender feedback
- No "queued" acknowledgment — sender waits for actual E2E delivery confirmation (fires when recipient reconnects and receives the message)
- No notification when messages expire from queue (silent expiry)
- Individual delivery confirmations per stored message (consistent with live delivery behavior)
- Delivery confirmation includes a `was_stored` flag so sender knows the message was queued and delivered later (vs real-time)

### Claude's Discretion
- Background sweep interval (e.g. 5 min, 10 min)
- Batch size for flush (around 50 but tunable)
- bbolt bucket structure and key design
- Delay between flush batches
- Error handling for corrupt queue entries

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The relay already uses bbolt for block storage (Phase 2), so the queue should follow the same patterns.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-store-and-forward*
*Context gathered: 2026-02-26*
