---
phase: 06-oversight-and-safety
verified: 2026-02-27T00:00:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 6: Oversight and Safety Verification Report

**Phase Goal:** Humans have full visibility into agent communication via an activity feed and audit log, can intervene in conversations, and the system is protected by rate limiting and circuit breakers
**Verified:** 2026-02-27
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Human can view a chronological activity feed of all sent/received messages and connection events, filterable by connection, time range, and message type | VERIFIED | `skill/src/autonomy/activity-feed.ts` `getEvents()` supports `connectionAddress`, `eventType`, `since`, `until`, `excludeEventTypes`, `limit`. `pinch-activity.ts` CLI exposes all filters. |
| 2 | Human can intervene in any conversation -- take over and send messages directly; messages are attributed as agent-sent or human-sent | VERIFIED | `pinch-intervene.ts` implements `--start`/`--stop`/`--send`. `SendMessageParams.attribution` field wired through `message-manager.ts` sendMessage with `application/x-pinch+json` wrapper. Inbound parsing detects attribution on receive. |
| 3 | Tamper-evident audit log with hash chaining records all messages and connection events with timestamp, actor pubkey, action type, connection ID, and message hash | VERIFIED | `activity-feed.ts` computes SHA-256 `computeEntryHash()` on every `record()` call, linking `prev_hash -> entry_hash`. Schema has `actor_pubkey`, `action_type`, `message_hash`, `prev_hash`, `entry_hash` columns. `pinch-audit-verify.ts` walks and verifies the chain. |
| 4 | Relay enforces per-connection rate limiting (token bucket or sliding window); excessive requests are rejected | VERIFIED | `relay/internal/hub/ratelimit.go` implements token bucket via `golang.org/x/time/rate`. Hub `RouteMessage()` calls `rateLimiter.Allow()` as first check; sends `RateLimited` proto envelope with `retry_after_ms=1000` on rejection. Configurable via env vars. Limiter cleaned up on disconnect. |
| 5 | Agent can mute a connection -- messages still delivered but not surfaced to agent or human | VERIFIED | `pinch-mute.ts` sets `connection.muted`. `enforcement-pipeline.ts` Step 0 checks `connection?.muted` before permissions; calls `messageStore.updateState("delivered")`, records `message_received_muted` event, and returns without surfacing. `pinch-activity.ts` excludes `message_received_muted` events by default. |

**Score:** 5/5 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `skill/src/autonomy/activity-feed.ts` | ActivityFeed with OVRS-06 columns, hash chaining, time range filtering | VERIFIED | 291 lines. `computeEntryHash` exported. All 5 Phase 6 columns present via `ALTER TABLE ADD COLUMN` migration. `getEvents()` supports `since`/`until`/`excludeEventTypes`. |
| `skill/src/tools/pinch-activity.ts` | CLI tool querying unified event log | VERIFIED | 97 lines. Exports `parseArgs` and `run`. Calls `activityFeed.getEvents()` with all filter parameters. Defaults muted event exclusion. |
| `relay/internal/hub/ratelimit.go` | Per-connection token bucket rate limiter | VERIFIED | 48 lines. `RateLimiter` struct with `Allow(address)` and `Remove(address)`. Uses `golang.org/x/time/rate`. Lazy limiter creation per address. |
| `proto/pinch/v1/envelope.proto` | MESSAGE_TYPE_RATE_LIMITED and RateLimited message | VERIFIED | `MESSAGE_TYPE_RATE_LIMITED = 15` in enum. `RateLimited` message with `retry_after_ms` and `reason`. `rate_limited = 24` in Envelope oneof. Generated TS has `RATE_LIMITED = 15` enum value. |
| `skill/src/tools/pinch-intervene.ts` | CLI tool for passthrough mode and human-attributed messages | VERIFIED | 139 lines. Exports `parseArgs` and `run`. Handles `--start`/`--stop`/`--send` modes. Calls `connectionStore.updateConnection({passthrough})` and `messageManager.sendMessage({attribution:"human"})`. |
| `skill/src/tools/pinch-mute.ts` | CLI tool for muting/unmuting connections | VERIFIED | 82 lines. Exports `parseArgs` and `run`. Calls `connectionStore.updateConnection({muted})`. Records activity feed events. |
| `skill/src/connection-store.ts` | Connection interface with muted and passthrough fields | VERIFIED | `muted?: boolean` and `passthrough?: boolean` in Connection interface. Both in `updateConnection` Pick<>. `clearPassthroughFlags()` method implemented as async, calls `save()`. |
| `skill/src/tools/pinch-audit-verify.ts` | CLI tool for hash chain verification | VERIFIED | 201 lines. Exports `parseArgs` and `run`. Imports `computeEntryHash` from `activity-feed.ts`. Walks chain ASC, verifies `entry_hash` and `prev_hash` linkage. Reports `valid`/`first_broken_at`/`broken_index`. |
| `skill/src/tools/pinch-audit-export.ts` | CLI tool for JSON audit log export | VERIFIED | 130 lines. Exports `parseArgs` and `run`. SELECT from `activity_events` with all hash chain columns. Writes JSON with `exported_at`, `total_entries`, `entries`. |
| `skill/SKILL.md` | Updated with all Phase 6 tools documented | VERIFIED | Documents `pinch_activity`, `pinch_intervene`, `pinch_mute`, `pinch_audit_verify`, `pinch_audit_export` with parameters and examples. |
| `skill/HEARTBEAT.md` | Audit chain health check included | VERIFIED | "Audit Chain Health" section at line 39 with `pinch_audit_verify` checklist item and example commands. |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `activity-feed.ts` | `node:crypto` | `createHash('sha256')` | WIRED | `import { createHash } from "node:crypto"` at line 14; used in `computeEntryHash()` at line 58. |
| `pinch-activity.ts` | `activity-feed.ts` | `activityFeed.getEvents()` | WIRED | `const { activityFeed } = await bootstrap()` then `activityFeed.getEvents(...)` with all filter params including `excludeEventTypes`. |
| `relay/internal/hub/hub.go` | `ratelimit.go` | `rateLimiter.Allow()` in `RouteMessage` | WIRED | Line 243: `if h.rateLimiter != nil && !h.rateLimiter.Allow(from.Address())`. First check in RouteMessage before envelope size check. |
| `relay/internal/hub/hub.go` | proto envelope | `sendRateLimited` builds RateLimited envelope | WIRED | Lines 369-386: `sendRateLimited` builds `Envelope_RateLimited` with `RetryAfterMs: 1000` and sends via `client.Send(data)`. |
| `relay/cmd/pinchd/main.go` | `ratelimit.go` | `hub.NewRateLimiter(rate, burst)` | WIRED | Lines 97-100: env var parsed, `rl := hub.NewRateLimiter(rate.Limit(rateLimit), rateBurst)`, passed to `hub.NewHub(blockStore, mq, rl)`. |
| `enforcement-pipeline.ts` | `connection-store.ts` | `connection?.muted` check | WIRED | Lines 53-54: `const connection = this.connectionStore.getConnection(connectionAddress); if (connection?.muted)`. |
| `enforcement-pipeline.ts` | `connection-store.ts` | `connection?.passthrough` check | WIRED | Lines 75-93: `if (connection?.passthrough)` routes message to `escalated_to_human` state. |
| `pinch-intervene.ts` | `connection-store.ts` | `updateConnection` passthrough flag | WIRED | Lines 72-74: `connectionStore.updateConnection(parsed.connection, { passthrough: true })` for `--start`; same with `false` for `--stop`. |
| `message-manager.ts` | PlaintextPayload content | `application/x-pinch+json` wrapper | WIRED | Lines 104-115: `wrappedContent = JSON.stringify({ text: body, attribution })`, contentType set to `"application/x-pinch+json"`. Inbound detection at lines 218-224. |
| `pinch-audit-verify.ts` | `activity-feed.ts` | `computeEntryHash` for chain verification | WIRED | Line 16: `import { computeEntryHash } from "../autonomy/activity-feed.js"`; line 117: `const expectedHash = computeEntryHash({...})`. |
| `pinch-audit-export.ts` | `activity_events` table | SQL SELECT all hash-chained entries | WIRED | Lines 77-83: `SELECT id, connection_address, event_type, ..., actor_pubkey, action_type, message_hash, prev_hash, entry_hash FROM activity_events ...`. |
| `skill/src/tools/cli.ts` | `connection-store.ts` | `clearPassthroughFlags()` on bootstrap | WIRED | Line 88: `await connectionStore.clearPassthroughFlags()` in `bootstrap()` after `connectionStore.load()`. |
| `skill/src/index.ts` | `activity-feed.ts` | `computeEntryHash` export | WIRED | Line 28: `export { ActivityFeed, computeEntryHash } from "./autonomy/activity-feed.js"`. |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| OVRS-01 | 06-01 | Human can view an activity feed showing all sent/received messages and connection events | SATISFIED | `ActivityFeed.getEvents()` queries all event types; `pinch-activity` CLI exposes it. |
| OVRS-02 | 06-01 | Activity feed is filterable by connection, time range, and message type | SATISFIED | `getEvents(opts)` accepts `connectionAddress`, `since`/`until`, `eventType`, `excludeEventTypes`. All exposed in `pinch-activity` CLI flags. |
| OVRS-03 | 06-03 | Human can intervene in any conversation -- take over and send messages directly | SATISFIED | `pinch-intervene --start/--stop` controls passthrough mode; `--send` sends human-attributed messages. Enforcement pipeline routes passthrough messages to `escalated_to_human`. |
| OVRS-04 | 06-03 | Messages are attributed as agent-sent or human-sent for conversation clarity | SATISFIED | `SendMessageParams.attribution` field; `application/x-pinch+json` content type wraps messages with `{ text, attribution }`. Inbound side parses attribution. |
| OVRS-05 | 06-01, 06-04 | Tamper-evident audit log with hash chaining records all messages and connection events | SATISFIED | SHA-256 `computeEntryHash()` on every `record()` call; `pinch-audit-verify` walks and verifies chain; `pinch-audit-export` exports all hash-chain fields. |
| OVRS-06 | 06-01, 06-04 | Audit log entries include: timestamp, actor pubkey, action type, connection ID, message hash | SATISFIED | Schema columns: `created_at`, `actor_pubkey`, `action_type`, `connection_address`, `message_hash` all present and recorded on every entry. |
| RELY-07 | 06-02 | Relay enforces per-connection rate limiting (token bucket or sliding window) | SATISFIED | `ratelimit.go` token bucket via `golang.org/x/time/rate`; integrated in `hub.RouteMessage()`; `RateLimited` proto envelope with `retry_after_ms`. |
| CONN-05 | 06-03 | Agent can mute a connection -- messages still delivered but not surfaced to agent/human | SATISFIED | `pinch-mute` sets `connection.muted`; enforcement pipeline Step 0 delivers with `state="delivered"`, records `message_received_muted` (excluded from activity feed by default), does not surface to agent/human. |

**All 8 requirements satisfied. Zero orphaned requirements.**

---

## Anti-Patterns Found

No anti-patterns detected across all Phase 6 files:
- No TODO/FIXME/PLACEHOLDER comments in any Phase 6 file
- No stub implementations (empty handlers, static returns)
- No orphaned artifacts (all files wired into bootstrap or called by other tools)
- No memory leak risk: `rateLimiter.Remove(address)` called in hub unregister path

---

## Human Verification Required

### 1. Rate Limiting Behavior Under Load

**Test:** Connect two WebSocket clients; have client A send more than 10 messages rapidly (within 1 second). Verify client A receives a `RateLimited` envelope and subsequent messages stop being routed.
**Expected:** After burst of 10, client A receives `{ retry_after_ms: 1000, reason: "per-connection rate limit exceeded" }`. Client B does not receive the rate-limited messages.
**Why human:** End-to-end WebSocket behavior with real relay; cannot verify relay rejection in isolation.

### 2. Message Attribution Visibility

**Test:** Use `pinch-intervene --send --connection <addr> --body "Hello from human"`. On the receiving side, observe the decoded message body.
**Expected:** Recipient sees `{ "text": "Hello from human", "attribution": "human" }` as raw content; if recipient understands `application/x-pinch+json`, it surfaces attribution correctly.
**Why human:** Cross-agent JSON parsing behavior depends on receiver implementation.

### 3. Passthrough Mode Full Flow

**Test:** Run `pinch-intervene --start --connection <addr>`, then send a message from the peer. Observe message state. Run `pinch-intervene --stop`. Observe state after handback.
**Expected:** During passthrough: message state is `escalated_to_human`, activity feed shows `message_during_intervention`. After stop: new messages route normally through enforcement pipeline.
**Why human:** End-to-end state machine behavior across live relay connection.

---

## Gaps Summary

No gaps found. All phase goal truths verified.

---

## Notes

**Muted delivery confirmation behavior:** When a connection is muted, `messageStore.updateState(message.id, "delivered")` is called, but `sendDeliveryConfirmation()` is NOT called from within the enforcement pipeline — that call occurs in `message-manager.ts` `handleIncomingMessage()` after `enforcementPipeline.process()` returns, regardless of the returned state. This means delivery confirmations are sent for muted messages, which correctly satisfies the CONN-05 requirement ("messages still delivered but not surfaced"). This design is intentional and correct.

**Passthrough bootstrap safety:** `clearPassthroughFlags()` is called in `bootstrap()` before any tools run, preventing stuck passthrough state across CLI disconnects. This is a safety net that correctly handles the disconnect scenario described in plan 06-03.

---

_Verified: 2026-02-27_
_Verifier: Claude (gsd-verifier)_
