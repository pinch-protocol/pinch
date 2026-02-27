---
phase: 03-encrypted-1-1-messaging
plan: 01
subsystem: relay
tags: [protobuf, delivery-confirm, size-limit, transient-buffer, websocket]

# Dependency graph
requires:
  - phase: 02-authentication-and-connection
    provides: Hub routing, client registration, block enforcement
provides:
  - DeliveryConfirm protobuf message for E2E signed delivery receipts
  - 64KB envelope size enforcement at relay RouteMessage entry point
  - 30-second transient buffer for offline recipients
  - Per-address pending message cap (100 messages)
  - WebSocket read limit aligned to envelope size limit
affects: [03-02, 03-03, 04-store-and-forward]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - pendingMessages map with TTL-based expiry and periodic cleanup goroutine
    - Application-level size enforcement with WS read limit set to 2x for silent drop semantics

key-files:
  created: []
  modified:
    - proto/pinch/v1/envelope.proto
    - gen/go/pinch/v1/envelope.pb.go
    - gen/ts/pinch/v1/envelope_pb.ts
    - relay/internal/hub/hub.go
    - relay/internal/hub/hub_test.go
    - relay/internal/hub/client.go

key-decisions:
  - "WebSocket read limit set to 2x maxEnvelopeSize (128KB) so oversized envelopes reach RouteMessage for application-level silent drop rather than WebSocket-level connection close"
  - "Pending message cleanup runs every 10s via ticker in Run goroutine (not separate goroutine) to maintain single-writer serialization model"
  - "PendingCount exported for test observability rather than exposing internal pendingMessages map"

patterns-established:
  - "Transient buffer pattern: pendingMessages map[string][]pendingMsg with TTL deadline, flushed on registration, swept by periodic cleanup"
  - "Size enforcement at application layer with WS layer allowing slightly larger frames"

requirements-completed: [CRYP-05, RELY-04]

# Metrics
duration: 9min
completed: 2026-02-27
---

# Phase 3 Plan 1: DeliveryConfirm Proto, 64KB Enforcement, Transient Buffer Summary

**DeliveryConfirm protobuf message with E2E delivery receipt fields, relay 64KB envelope size enforcement, and 30-second transient buffer for offline recipients**

## Performance

- **Duration:** 9 min
- **Started:** 2026-02-27T03:45:14Z
- **Completed:** 2026-02-27T03:54:09Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- DeliveryConfirm message defined in protobuf with message_id, signature, timestamp, and state fields; generated Go and TypeScript code includes the new type
- Relay enforces 64KB max envelope size at RouteMessage entry point with silent drop
- Messages to offline recipients are buffered for up to 30 seconds, flushed on reconnection, with periodic cleanup of expired entries
- Per-address pending queue capped at 100 messages to prevent memory abuse
- 4 new hub tests: size drop, reconnect delivery, expiry, and cap enforcement

## Task Commits

Each task was committed atomically:

1. **Task 1: Add DeliveryConfirm protobuf message and regenerate code** - `476bdf5` (feat)
2. **Task 2: Add relay 64KB size enforcement and 30-second transient buffer** - `03be9b3` (feat)

## Files Created/Modified
- `proto/pinch/v1/envelope.proto` - Added DeliveryConfirm message definition and Envelope oneof case
- `gen/go/pinch/v1/envelope.pb.go` - Regenerated Go protobuf code with DeliveryConfirm type
- `gen/ts/pinch/v1/envelope_pb.ts` - Regenerated TypeScript protobuf code with DeliveryConfirm type
- `relay/internal/hub/hub.go` - maxEnvelopeSize constant, size check in RouteMessage, pendingMessages map with TTL, cleanup ticker, flush on registration, PendingCount helper
- `relay/internal/hub/hub_test.go` - 4 new tests for size enforcement, transient buffer delivery, expiry, and per-address cap
- `relay/internal/hub/client.go` - SetReadLimit to 2x maxEnvelopeSize in ReadPump for application-level size enforcement

## Decisions Made
- WebSocket read limit set to 2x maxEnvelopeSize (128KB) so oversized envelopes reach RouteMessage for application-level silent drop rather than WebSocket-level connection close. This preserves the plan's "silent drop" requirement where the connection stays open.
- Pending message cleanup integrated into the Run goroutine's select loop via ticker (not a separate goroutine) to maintain the existing single-writer serialization model for the routing table and pending messages.
- Exported PendingCount method for test observability rather than exposing internal pendingMessages map directly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Set WebSocket read limit for size enforcement**
- **Found during:** Task 2 (size enforcement implementation)
- **Issue:** Default coder/websocket read limit is 32KB, but our envelope limit is 64KB. Oversized messages (e.g., 70KB test envelope) would cause WebSocket-level connection close instead of reaching RouteMessage for application-level silent drop.
- **Fix:** Added `c.conn.SetReadLimit(2 * maxEnvelopeSize)` in ReadPump to allow messages up to 128KB at the WebSocket layer, with RouteMessage enforcing the 64KB application limit.
- **Files modified:** relay/internal/hub/client.go
- **Verification:** TestMaxEnvelopeSizeDrop passes -- 70KB envelope silently dropped without disconnecting sender
- **Committed in:** 03be9b3 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Essential for correct size enforcement behavior. Without the WS read limit increase, oversized messages would close connections instead of being silently dropped.

## Issues Encountered
- TestPendingMessageExpires initially failed with 35-second wait. The cleanup ticker (10s interval) plus TTL (30s) plus connection setup time meant the first cleanup after expiry could occur as late as ~42s from test start. Increased wait to 45 seconds to accommodate worst-case timing.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- DeliveryConfirm proto type available for 03-02 (delivery confirmation signing)
- Transient buffer pattern established for 04 (full store-and-forward will replace with persistent bbolt queue)
- All 21 hub tests passing (17 existing + 4 new)

## Self-Check: PASSED

All files exist, both commits verified, DeliveryConfirm present in generated code, maxEnvelopeSize present in hub.go.

---
*Phase: 03-encrypted-1-1-messaging*
*Completed: 2026-02-27*
