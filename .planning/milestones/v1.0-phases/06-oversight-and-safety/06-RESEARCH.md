# Phase 6: Oversight and Safety - Research

**Researched:** 2026-02-27
**Domain:** Human oversight, tamper-evident logging, rate limiting, connection muting
**Confidence:** HIGH

## Summary

Phase 6 adds the human oversight layer on top of Pinch's existing autonomous agent infrastructure. The existing `ActivityFeed` (SQLite table `activity_events`) from Phase 5 provides a foundation but needs significant evolution: it currently records only autonomy-related events (message processing, circuit breaker trips) with a narrow schema. Phase 6 transforms it into a unified event log covering all system events, adds SHA-256 hash chaining for tamper evidence, introduces new skill tools (`pinch_activity`, `pinch_audit_verify`, `pinch_intervene`), implements relay-side rate limiting in Go using `golang.org/x/time/rate`, and adds connection muting as a local-only filter in the TypeScript skill layer.

The implementation spans both the Go relay (rate limiting) and the TypeScript skill (everything else). The relay change is self-contained -- a new `RateLimiter` type in `relay/internal/hub/` that wraps `golang.org/x/time/rate.Limiter` with per-connection tracking. The TypeScript changes are more extensive: evolving the ActivityFeed schema, adding hash chaining, building intervention/passthrough mode in the message pipeline, and adding mute state to ConnectionStore.

**Primary recommendation:** Evolve the existing `ActivityFeed` class into a unified event log with hash chaining rather than creating a separate audit store. Use Node.js built-in `crypto.createHash('sha256')` for hashing (zero new dependencies). Use `golang.org/x/time/rate` for relay rate limiting (standard Go extended library, already familiar ecosystem). Add a `muted` boolean to the Connection interface and filter in the enforcement pipeline.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Activity Feed**: Compact one-liner entries in a unified event log (single append-only table for all event types)
- **Activity Feed**: Agent consumes structured entries and composes natural-language summaries -- feed is not human-facing directly
- **Activity Feed**: Everything generates feed entries: messages sent/received, connection requests, approvals, rejections, blocks, revokes, autonomy changes, permission updates
- **Activity Feed**: Filterable by: connection (specific or all), time range (since timestamp), event type (messages, connections, autonomy changes)
- **Activity Feed**: A `pinch_activity` skill tool queries the unified event log with filter parameters
- **Human Intervention**: Inline command model -- human tells agent "I'll handle this one", agent switches to passthrough mode for that connection
- **Human Intervention**: During passthrough, agent still receives incoming messages, surfaces them to human, and can add context
- **Human Intervention**: Human's replies sent as Pinch messages with human attribution
- **Human Intervention**: Explicit handback to end intervention
- **Human Intervention**: Visible attribution on receiving end -- messages carry agent-sent or human-sent flag
- **Audit Log**: Same store as unified event log -- hash chaining added to event log entries, not a separate store
- **Audit Log**: SHA-256 hash chaining -- each entry includes hash of itself + previous entry's hash
- **Audit Log**: Grows indefinitely -- no retention policy, no purging
- **Audit Log**: Verification via skill tool (`pinch_audit_verify`) for quick checks
- **Audit Log**: Verification via export -- dump to JSON, standalone script verifies independently
- **Audit Log**: Entries include: timestamp, actor pubkey, action type, connection ID, message hash
- **Rate Limiting**: Relay-side (Go) per-connection rate limiting
- **Rate Limiting**: Generous defaults -- agents can be chatty; only catch obvious abuse (60 msgs/min, 1000/hr range)
- **Rate Limiting**: On rate limit: sender receives error with retry-after duration
- **Muting**: Silent mute -- sender has no idea they've been muted; messages appear to deliver normally
- **Muting**: Muted messages still recorded in audit log, not surfaced in activity feed or to agent/human
- **Muting**: Muting is a local decision -- no notification to other side

### Claude's Discretion
- Token bucket vs sliding window algorithm choice for rate limiting
- Exact rate limit default values (within the "generous" range)
- Internal schema design for the unified event log
- How passthrough mode is tracked internally (connection state, timeout safeguards)
- Export format details for audit log verification

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OVRS-01 | Human can view activity feed of all sent/received messages and connection events | Unified event log schema evolution + `pinch_activity` tool |
| OVRS-02 | Activity feed filterable by connection, time range, message type | SQL WHERE clauses on evolved activity_events table with time range filter |
| OVRS-03 | Human can intervene in conversation -- take over and send messages directly | Passthrough mode on ConnectionStore + `pinch_intervene` tool |
| OVRS-04 | Messages attributed as agent-sent or human-sent | `attribution` field on outbound messages + PlaintextPayload metadata |
| OVRS-05 | Tamper-evident audit log with hash chaining | SHA-256 hash chain columns on activity_events table |
| OVRS-06 | Audit entries: timestamp, actor pubkey, action type, connection ID, message hash | Evolved schema with actor_pubkey, action_type, connection_id, message_hash, prev_hash, entry_hash columns |
| RELY-07 | Relay enforces per-connection rate limiting | Go `golang.org/x/time/rate.Limiter` per-client in hub |
| CONN-05 | Agent can mute a connection | `muted` boolean on Connection + enforcement pipeline filter |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `golang.org/x/time/rate` | latest | Token bucket rate limiter for Go relay | Official Go extended library, 13K+ importers, thread-safe, built-in Allow/Reserve/Wait |
| `node:crypto` (built-in) | Node.js 20+ | SHA-256 hashing for audit log hash chain | Zero dependency, `createHash('sha256')` is standard Node.js API |
| `better-sqlite3` | ^12.6.2 | Already used -- evolve existing activity_events table | Already in project, synchronous API ideal for hash chaining |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `uuid` | ^13.0.0 | Already used -- UUIDv7 for event IDs (time-ordered) | Every new activity event entry |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `golang.org/x/time/rate` (token bucket) | Sliding window counter | Sliding window is more predictable but harder to implement correctly; token bucket is standard, allows bursts naturally |
| `node:crypto` SHA-256 | libsodium `crypto_hash_sha256` | Already have libsodium in project, but `node:crypto` is simpler for this use case and avoids async sodium init |
| Separate audit table | Hash chaining on existing activity_events | User locked: same store, not separate. Evolving existing table is cleaner |

**Installation:**
```bash
# Go relay -- add rate limiter dependency
cd relay && go get golang.org/x/time/rate

# TypeScript skill -- no new packages needed (node:crypto is built-in)
```

## Architecture Patterns

### Recommended Project Structure
```
relay/internal/
├── hub/
│   ├── hub.go           # Add rate limiter integration to RouteMessage
│   ├── client.go        # Existing -- no changes needed
│   └── ratelimit.go     # NEW: Per-connection rate limiter (token bucket)
├── store/               # Existing -- no changes needed
│
skill/src/
├── autonomy/
│   ├── activity-feed.ts # EVOLVE: Unified event log with hash chaining
│   └── enforcement-pipeline.ts  # MODIFY: Add mute check before routing
├── connection-store.ts  # MODIFY: Add muted field + passthrough state
├── message-manager.ts   # MODIFY: Add attribution to outbound messages
├── tools/
│   ├── pinch-activity.ts    # NEW: Query unified event log with filters
│   ├── pinch-intervene.ts   # NEW: Enter/exit passthrough mode
│   └── pinch-audit-verify.ts # NEW: Verify hash chain integrity
│   └── pinch-audit-export.ts # NEW: Export audit log to JSON
```

### Pattern 1: Evolving the ActivityFeed Schema (SQLite Migration)
**What:** Add new columns to the existing `activity_events` table for hash chaining and OVRS-06 fields, while preserving backward compatibility
**When to use:** At ActivityFeed construction time (same pattern as existing `initSchema`)

```typescript
// Evolve the existing activity_events table with new columns.
// SQLite ALTER TABLE ADD COLUMN is safe for append-only operations.
// The existing columns remain intact; new columns get defaults.
private initSchema(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      connection_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message_id TEXT,
      badge TEXT,
      details TEXT,
      created_at TEXT NOT NULL,
      -- Phase 6 additions for OVRS-06 and hash chaining
      actor_pubkey TEXT,
      action_type TEXT,
      message_hash TEXT,
      prev_hash TEXT NOT NULL DEFAULT '',
      entry_hash TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_activity_events_connection
      ON activity_events(connection_address, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_events_type
      ON activity_events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_events_created_range
      ON activity_events(created_at);
  `);
}
```

**Key insight:** Use `ALTER TABLE ADD COLUMN ... DEFAULT ''` for each new column if the table already exists. SQLite handles this without rewriting the table. Check for column existence first with `PRAGMA table_info(activity_events)`.

### Pattern 2: SHA-256 Hash Chaining
**What:** Each event entry includes a hash computed from its own data concatenated with the previous entry's hash, creating a tamper-evident chain
**When to use:** On every `record()` call in ActivityFeed

```typescript
import { createHash } from "node:crypto";

// Compute the hash for a new entry
function computeEntryHash(entry: {
  id: string;
  timestamp: string;
  actorPubkey: string;
  actionType: string;
  connectionAddress: string;
  messageHash: string;
  prevHash: string;
}): string {
  const data = [
    entry.id,
    entry.timestamp,
    entry.actorPubkey,
    entry.actionType,
    entry.connectionAddress,
    entry.messageHash,
    entry.prevHash,
  ].join("|");
  return createHash("sha256").update(data).digest("hex");
}

// In record(): get the last entry's hash, compute new hash, insert
const lastHash = this.db.prepare(
  "SELECT entry_hash FROM activity_events ORDER BY created_at DESC, id DESC LIMIT 1"
).get();
const prevHash = (lastHash as any)?.entry_hash ?? "";
const entryHash = computeEntryHash({ ...eventData, prevHash });
```

**Critical concurrency note:** The hash chain requires serialized writes. Since better-sqlite3 is synchronous and single-connection, this is naturally serialized. No additional locking needed.

### Pattern 3: Relay-Side Token Bucket Rate Limiting (Go)
**What:** Per-connection rate limiter using `golang.org/x/time/rate` that tracks limiters per pinch address and rejects excessive messages
**When to use:** In `hub.RouteMessage()` before processing the message

```go
import "golang.org/x/time/rate"

// RateLimiter manages per-connection token bucket rate limiters.
type RateLimiter struct {
    mu       sync.RWMutex
    limiters map[string]*rate.Limiter
    rate     rate.Limit  // tokens per second (e.g., 1.0 = 60/min)
    burst    int         // max burst size (e.g., 10)
}

func NewRateLimiter(r rate.Limit, burst int) *RateLimiter {
    return &RateLimiter{
        limiters: make(map[string]*rate.Limiter),
        rate:     r,
        burst:    burst,
    }
}

func (rl *RateLimiter) Allow(address string) bool {
    rl.mu.Lock()
    limiter, ok := rl.limiters[address]
    if !ok {
        limiter = rate.NewLimiter(rl.rate, rl.burst)
        rl.limiters[address] = limiter
    }
    rl.mu.Unlock()
    return limiter.Allow()
}
```

**Recommended defaults (Claude's discretion):**
- Rate: 1.0 token/second (= 60 messages/minute sustained)
- Burst: 10 (allows short bursts of rapid messages)
- This means: 60 msgs/min sustained, up to 10 in a burst, ~1000/hr well within "generous" range

### Pattern 4: Passthrough Mode for Human Intervention
**What:** A per-connection flag that routes incoming messages to the human and sends outbound messages with human attribution
**When to use:** When human says "I'll handle this one" -- agent calls `pinch_intervene --start --connection <addr>`

```typescript
// Connection interface addition
interface Connection {
  // ... existing fields ...
  muted?: boolean;          // CONN-05: silent mute
  passthrough?: boolean;    // OVRS-03: human intervention mode
}

// In enforcement pipeline: if passthrough, skip autonomy routing
// and set state to "escalated_to_human" directly
if (connection.passthrough) {
  this.messageStore.updateState(message.id, "escalated_to_human");
  this.activityFeed.record({
    connectionAddress,
    eventType: "message_during_intervention",
    messageId: message.id,
    badge: "intervention",
  });
  return { ...routed, state: "escalated_to_human" };
}
```

### Pattern 5: Message Attribution (OVRS-04)
**What:** Outbound messages carry an `attribution` field indicating whether the message was sent by the agent or the human
**When to use:** On every outbound message in `pinch_send` and `pinch_intervene`

The attribution needs to reach the receiving end. Two options:
1. **Content-type metadata in PlaintextPayload:** Add to the `content_type` field (e.g., `text/plain;attribution=human`)
2. **Structured content wrapper:** Wrap body as JSON `{ "body": "...", "attribution": "human" }` with `content_type: application/json+pinch`

Recommendation: Use structured content wrapper in the PlaintextPayload `content` field. The receiving agent already decodes `content` from bytes -- it can check for the JSON wrapper. This avoids protobuf schema changes and is forward-compatible.

```typescript
// Outbound message with attribution
const payload = JSON.stringify({
  text: body,
  attribution: isHumanIntervention ? "human" : "agent",
});
// Set content_type to "application/x-pinch+json" to signal structured content
```

### Pattern 6: Muting (CONN-05)
**What:** Connection-level mute flag that silently records messages to audit log without surfacing them
**When to use:** Early in the enforcement pipeline, after decryption but before routing

```typescript
// In enforcement pipeline process():
// After step 1 (permissions) but before step 2 (circuit breaker):
const connection = this.connectionStore.getConnection(connectionAddress);
if (connection?.muted) {
  // Record in audit log (hash-chained activity_events)
  this.activityFeed.record({
    connectionAddress,
    eventType: "message_received_muted",
    messageId: message.id,
    actorPubkey: senderPubkey,
    actionType: "message_receive",
  });
  // Mark message as delivered (for confirmation) but don't surface
  this.messageStore.updateState(message.id, "delivered");
  return { ...routed, state: "delivered" };
}
```

### Anti-Patterns to Avoid
- **Separate audit store:** User locked: same store as event log. Don't create a second table.
- **Hashing in SQLite:** Don't use SQLite extensions for SHA-256. Use Node.js `crypto` in application code for portability and testability.
- **Mute notification:** User locked: silent mute. Never tell the sender they're muted. Delivery confirmations still sent.
- **Rate limiting in TypeScript:** User locked: relay-side (Go). Don't implement in the skill layer.
- **Blocking hash chain writes:** The chain must be computed sequentially, but better-sqlite3 is synchronous -- don't add async complexity.
- **Modifying protobuf schema for attribution:** Avoid changing `envelope.proto` for attribution. Use the existing `content_type` + structured content in PlaintextPayload instead. Protobuf changes require regenerating Go + TS code and carry higher risk.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token bucket rate limiting | Custom counter + timer | `golang.org/x/time/rate.Limiter` | Thread-safe, well-tested, handles burst, standard Go library |
| SHA-256 hashing | Custom hash function | `node:crypto.createHash('sha256')` | Built into Node.js, zero dependencies, battle-tested |
| Rate limiter cleanup (stale entries) | Manual map iteration | `sync.Map` or periodic cleanup goroutine | Prevent memory leak from disconnected clients' limiters |
| Ordered event retrieval | Custom sorting | SQLite `ORDER BY created_at, id` | Database handles ordering; UUIDv7 IDs are time-ordered |

**Key insight:** The most complex custom work in this phase is the hash chaining integration into the existing ActivityFeed and the passthrough/intervention mode. Everything else leverages existing libraries and patterns already in the codebase.

## Common Pitfalls

### Pitfall 1: Hash Chain Breaks on Schema Migration
**What goes wrong:** If existing activity_events rows don't have `entry_hash`/`prev_hash`, the chain has a gap. New entries reference a `prev_hash` of `""` even when old entries exist.
**Why it happens:** ALTER TABLE ADD COLUMN sets defaults, but old rows have empty hash fields.
**How to avoid:** Treat the first hash-chained entry as a "genesis" entry with `prev_hash = ""`. The verification tool should detect and report the genesis point. Old entries without hashes are pre-audit and not part of the chain.
**Warning signs:** `pinch_audit_verify` reports chain break at the transition point.

### Pitfall 2: Rate Limiter Memory Leak
**What goes wrong:** Per-connection rate limiters accumulate indefinitely as new connections come and go. The `limiters` map grows without bound.
**Why it happens:** Limiters are created on first message but never cleaned up when clients disconnect.
**How to avoid:** Add cleanup in the hub's `unregister` path -- when a client disconnects, remove its limiter entry. Optionally add a periodic sweep for stale entries.
**Warning signs:** Relay memory usage grows linearly with total unique connections ever seen.

### Pitfall 3: Passthrough Mode Stuck After Disconnect
**What goes wrong:** Human enters passthrough mode, then disconnects. Passthrough flag persists on the connection, so the agent never processes messages for that connection again.
**Why it happens:** Passthrough is persisted in ConnectionStore JSON but no timeout or heartbeat resets it.
**How to avoid:** Add a timeout safeguard. Option A: `passthroughExpiresAt` field that auto-clears after N hours of inactivity. Option B: On each bootstrap, clear all passthrough flags (reasonable since the human must be present for passthrough to be meaningful).
**Warning signs:** Messages pile up in `escalated_to_human` state for a connection where no human is reviewing.

### Pitfall 4: Rate Limit Error Not Reaching Sender as Actionable Feedback
**What goes wrong:** Relay rejects the message but the sender gets a generic WebSocket error or silent drop.
**Why it happens:** RouteMessage currently drops messages silently. Rate-limited messages need an explicit error response.
**How to avoid:** Send a protobuf error envelope back to the sender with rate limit information. Need a new `MESSAGE_TYPE_RATE_LIMITED` enum value and `RateLimited` message type in `envelope.proto`, or reuse the existing error pattern (like `QueueFull`).
**Warning signs:** Agents keep retrying at full speed because they never received the rate limit signal.

### Pitfall 5: Muted Messages Still Triggering Circuit Breaker
**What goes wrong:** Muted connection floods messages, circuit breaker trips, but the human never wanted to interact with this connection anyway.
**Why it happens:** Mute check happens in enforcement pipeline but circuit breaker recording happens before the mute check.
**How to avoid:** Check mute status BEFORE circuit breaker recording. If muted, skip the entire enforcement pipeline -- just record to audit log and send delivery confirmation.
**Warning signs:** Circuit breaker trips on connections the human intentionally muted.

### Pitfall 6: Hash Chain Verification Performance on Large Logs
**What goes wrong:** `pinch_audit_verify` takes too long on logs with thousands of entries, making it impractical to use.
**Why it happens:** Full chain walk requires reading every row and computing SHA-256 for each.
**How to avoid:** Add pagination to verification (verify N entries at a time). Also, SHA-256 is fast (~1M hashes/sec in Node.js) so even 100K entries should complete in < 1 second. Add a `--tail N` option to verify only the most recent N entries for quick checks.
**Warning signs:** Verification tool reports "timeout" on large audit logs.

## Code Examples

### Rate Limiter Integration in RouteMessage (Go)

```go
// In hub.go RouteMessage, before processing:
func (h *Hub) RouteMessage(from *Client, envelope []byte) error {
    // Rate limit check (before any processing)
    if h.rateLimiter != nil && !h.rateLimiter.Allow(from.Address()) {
        h.sendRateLimited(from)
        return nil
    }
    // ... existing RouteMessage logic ...
}
```

### Unified Event Log Record Method (TypeScript)

```typescript
record(event: {
  connectionAddress: string;
  eventType: string;
  messageId?: string;
  badge?: string;
  details?: string;
  actorPubkey?: string;
  actionType?: string;
  messageHash?: string;
}): ActivityEvent {
  const id = uuidv7();
  const createdAt = new Date().toISOString();

  // Get previous hash for chain
  const lastRow = this.db.prepare(
    "SELECT entry_hash FROM activity_events ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get() as { entry_hash: string } | undefined;
  const prevHash = lastRow?.entry_hash ?? "";

  // Compute entry hash
  const entryHash = computeEntryHash({
    id, createdAt, prevHash,
    actorPubkey: event.actorPubkey ?? "",
    actionType: event.actionType ?? event.eventType,
    connectionAddress: event.connectionAddress,
    messageHash: event.messageHash ?? "",
  });

  this.db.prepare(`
    INSERT INTO activity_events (
      id, connection_address, event_type, message_id, badge,
      details, created_at, actor_pubkey, action_type,
      message_hash, prev_hash, entry_hash
    ) VALUES (
      @id, @connectionAddress, @eventType, @messageId, @badge,
      @details, @createdAt, @actorPubkey, @actionType,
      @messageHash, @prevHash, @entryHash
    )
  `).run({
    id,
    connectionAddress: event.connectionAddress,
    eventType: event.eventType,
    messageId: event.messageId ?? null,
    badge: event.badge ?? null,
    details: event.details ?? null,
    createdAt,
    actorPubkey: event.actorPubkey ?? null,
    actionType: event.actionType ?? event.eventType,
    messageHash: event.messageHash ?? null,
    prevHash,
    entryHash,
  });

  return { id, ...event, createdAt, prevHash, entryHash };
}
```

### Audit Chain Verification (TypeScript)

```typescript
function verifyChain(db: DatabaseType): {
  valid: boolean;
  totalEntries: number;
  firstBrokenAt?: string;
} {
  const rows = db.prepare(
    "SELECT * FROM activity_events WHERE entry_hash != '' ORDER BY created_at ASC, id ASC"
  ).all() as AuditRow[];

  let prevHash = "";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expected = computeEntryHash({
      id: row.id,
      createdAt: row.created_at,
      actorPubkey: row.actor_pubkey ?? "",
      actionType: row.action_type ?? row.event_type,
      connectionAddress: row.connection_address,
      messageHash: row.message_hash ?? "",
      prevHash,
    });

    if (expected !== row.entry_hash) {
      return { valid: false, totalEntries: rows.length, firstBrokenAt: row.id };
    }
    prevHash = row.entry_hash;
  }

  return { valid: true, totalEntries: rows.length };
}
```

### Protobuf Addition for Rate Limit Error

```protobuf
// Add to MessageType enum:
MESSAGE_TYPE_RATE_LIMITED = 15;

// Add new message type:
message RateLimited {
  int64 retry_after_ms = 1;  // milliseconds until sender can retry
  string reason = 2;          // human-readable explanation
}

// Add to Envelope oneof payload:
RateLimited rate_limited = 24;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate audit table | Unified event log with hash chaining | Phase 6 user decision | Single source of truth for all events |
| ActivityFeed for autonomy events only | Unified event log for ALL events | Phase 6 evolution | All message sends/receives, connection events get logged |
| No human intervention capability | Passthrough mode per-connection | Phase 6 new feature | Human can directly communicate via agent's Pinch identity |
| No rate limiting | Relay-side token bucket | Phase 6 new feature | Protection against abuse at the transport layer |

**Deprecated/outdated:**
- ActivityFeed's current narrow schema (only `connection_address`, `event_type`, `message_id`, `badge`, `details`, `created_at`) will be expanded with OVRS-06 fields and hash chain columns
- The current `getEvents()` method signature needs a `since` parameter for time range filtering (OVRS-02)

## Open Questions

1. **Protobuf schema change for rate limit error**
   - What we know: Need a way to signal rate limiting back to the sender. Existing patterns include `QueueFull` with a dedicated message type.
   - What's unclear: Whether to add `MESSAGE_TYPE_RATE_LIMITED` + `RateLimited` message to the protobuf schema, or reuse existing error patterns. Adding a new message type requires `buf generate` and updating both Go and TS generated code.
   - Recommendation: Add `MESSAGE_TYPE_RATE_LIMITED` and `RateLimited` message type. It follows the established pattern (like `QueueFull`) and gives the client actionable `retry_after_ms`. The protobuf change is small and the codegen is already automated via `buf.gen.yaml`.

2. **Attribution wire format**
   - What we know: Messages need to carry agent-sent vs human-sent attribution to the receiving end.
   - What's unclear: Whether to modify `PlaintextPayload` protobuf (add an `attribution` string field) or use a structured JSON wrapper in the existing `content` bytes field.
   - Recommendation: Use structured JSON wrapper in `content` bytes (with `content_type: "application/x-pinch+json"`). This avoids protobuf changes and is backward-compatible -- receivers that don't understand the wrapper just see JSON text. Minimal disruption.

3. **Rate limiter stale entry cleanup strategy**
   - What we know: Per-connection limiters need cleanup to prevent memory leaks.
   - What's unclear: Whether hub unregister is sufficient (handles disconnects) or if we also need periodic sweeps for limiters that survive across reconnections.
   - Recommendation: Clean up on hub unregister. Limiters are cheap (~100 bytes each) and reconnecting clients get a fresh limiter with full burst capacity, which is the correct behavior.

## Sources

### Primary (HIGH confidence)
- `golang.org/x/time/rate` - [Official Go package docs](https://pkg.go.dev/golang.org/x/time/rate) - Token bucket API, thread safety, usage patterns
- `node:crypto` - [Node.js v25 official docs](https://nodejs.org/api/crypto.html) - `createHash('sha256')` API

### Secondary (MEDIUM confidence)
- [Building a Tamper-Evident Audit Log with SHA-256 Hash Chains](https://dev.to/veritaschain/building-a-tamper-evident-audit-log-with-sha-256-hash-chains-zero-dependencies-h0b) - Hash chain pattern, verification approach
- [Go Wiki: Rate Limiting](https://go.dev/wiki/RateLimiting) - Ecosystem patterns for per-connection limiting
- [Let's Make a Hash Chain in SQLite](https://www.viget.com/articles/lets-make-a-hash-chain-in-sqlite) - SQLite-specific hash chain implementation pattern

### Tertiary (LOW confidence)
- None -- all findings verified with primary or secondary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Using Go standard extended library (`golang.org/x/time/rate`) and Node.js built-in (`node:crypto`). Zero new dependencies for TypeScript. One new Go dependency that's an official extended library.
- Architecture: HIGH - Evolving existing patterns (ActivityFeed, ConnectionStore, enforcement pipeline) rather than introducing new ones. All modifications follow established project conventions.
- Pitfalls: HIGH - Based on direct codebase analysis. Race conditions in hash chaining are naturally prevented by better-sqlite3's synchronous API. Rate limiter cleanup and passthrough timeout are straightforward to implement.

**Research date:** 2026-02-27
**Valid until:** 2026-03-27 (stable domain -- cryptographic hashing, rate limiting, and SQLite patterns change slowly)
