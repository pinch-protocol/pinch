---
phase: 04-store-and-forward
plan: 02
subsystem: relay
tags: [bbolt, message-queue, store-and-forward, flush, websocket, protobuf, integration-test]

# Dependency graph
requires:
  - phase: 04-store-and-forward
    provides: "MessageQueue store with enqueue, flush, remove, count, sweep operations; shared DB handle; proto QueueStatus/QueueFull messages"
provides:
  - "Hub routes offline messages to bbolt MessageQueue instead of in-memory buffer"
  - "Batched flush (50/batch) on reconnect with QueueStatus envelope sent first"
  - "QueueFull error envelope sent to sender when per-agent cap exceeded"
  - "Flushing flag prevents real-time bypass during flush to preserve ordering"
  - "TypeScript handles was_stored, QueueStatus, QueueFull envelopes"
  - "Cross-language integration tests proving end-to-end store-and-forward flow"
affects: [relay-hub, skill-messaging, deployment]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Immediate deletion on flush send (Remove after Send) to prevent duplicate delivery"
    - "Atomic flushing flag (sync/atomic) for lock-free reads in hot routing path"
    - "QueueStatus envelope sent before flush to inform client of pending count"
    - "Env var config for queue cap (PINCH_RELAY_QUEUE_MAX) and TTL (PINCH_RELAY_QUEUE_TTL)"

key-files:
  created:
    - "tests/cross-language/store-forward.integration.test.ts"
  modified:
    - "relay/internal/hub/hub.go"
    - "relay/internal/hub/client.go"
    - "relay/internal/hub/hub_test.go"
    - "relay/cmd/pinchd/main.go"
    - "skill/src/message-manager.ts"
    - "skill/src/message-manager.test.ts"

key-decisions:
  - "Immediate deletion on flush (Remove after Send) instead of deferred deletion via delivery confirmation, to prevent duplicate delivery in flush loop"
  - "Flushing flag uses sync/atomic for lock-free reads on the hot routing path"
  - "Messages during flush enqueued to bbolt (not real-time) to preserve chronological ordering"
  - "Cross-language integration test placed at tests/cross-language/ with relative imports to skill/src"

patterns-established:
  - "Env var config pattern: PINCH_RELAY_QUEUE_MAX and PINCH_RELAY_QUEUE_TTL with defaults"
  - "Immediate deletion flush: send then remove, rather than collect-then-confirm-then-remove"

requirements-completed: [RELY-05, RELY-06]

# Metrics
duration: 10min
completed: 2026-02-27
---

# Phase 4 Plan 2: Hub Store-and-Forward Integration Summary

**Hub wired to bbolt MessageQueue with batched flush on reconnect, QueueFull error feedback, flushing state management, TypeScript envelope handlers, and cross-language integration tests**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-27T05:14:30Z
- **Completed:** 2026-02-27T05:24:32Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Hub routes offline messages to bbolt MessageQueue; in-memory pending buffer completely removed
- Batched flush (50/batch) on reconnect with QueueStatus sent first, QueueFull error to sender when cap exceeded
- TypeScript MessageManager handles was_stored flag, QueueStatus, and QueueFull envelopes
- Cross-language integration tests prove end-to-end offline queue/reconnect flush and queue-full error flow

## Task Commits

Each task was committed atomically:

1. **Task 1: Hub integration with MessageQueue, batched flush, and flushing state** - `6f21137` (feat)
2. **Task 2: TypeScript was_stored handling and cross-language integration tests** - `47c48bd` (feat)

## Files Created/Modified
- `relay/internal/hub/hub.go` - Hub with MessageQueue integration, batched flush, QueueFull response, delivery confirmation correlation
- `relay/internal/hub/client.go` - Client with flushing atomic bool, TrackFlushKey/PopFlushKey for delivery confirmation correlation
- `relay/internal/hub/hub_test.go` - 4 new tests (enqueue offline, queue full, flush on reconnect, flush before real-time); removed 3 old in-memory pending tests
- `relay/cmd/pinchd/main.go` - Passes MessageQueue to Hub, starts background sweep, configurable env vars
- `skill/src/message-manager.ts` - Handles was_stored on delivery confirms, QueueStatus, QueueFull envelopes
- `skill/src/message-manager.test.ts` - 3 new unit tests for store-and-forward envelope handlers
- `tests/cross-language/store-forward.integration.test.ts` - 2 integration tests: offline reconnect flush, queue full error

## Decisions Made
- Immediate deletion on flush (Remove after Send) instead of deferred deletion via delivery confirmation to prevent duplicate delivery when FlushBatch re-reads the queue
- Flushing flag uses sync/atomic for lock-free reads on the hot routing path (RouteMessage checks IsFlushing on every message)
- Messages arriving during flush are enqueued to bbolt rather than delivered real-time, preserving chronological ordering
- Cross-language integration test placed at tests/cross-language/ with relative imports (workspace resolver doesn't cover that path)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Flush loop duplicate delivery prevention**
- **Found during:** Task 2 (cross-language integration tests)
- **Issue:** FlushBatch is a non-destructive read; the flush loop re-reads the same entries on the next iteration before delivery confirmations can trigger removal, causing duplicate message delivery (SQLITE_CONSTRAINT_PRIMARYKEY errors on the TypeScript side)
- **Fix:** Changed flush to use immediate deletion (Remove after Send) instead of deferred deletion via delivery confirmation correlation
- **Files modified:** relay/internal/hub/hub.go
- **Verification:** Cross-language integration tests pass with no duplicate delivery errors
- **Committed in:** 47c48bd (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential fix for correctness. The plan's delivery-confirmation-based deletion design had a race condition with the flush loop; immediate deletion is simpler and eliminates the duplicate delivery issue entirely.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Store-and-forward feature is fully complete: durable bbolt persistence, batched flush, queue-full feedback, delivery confirmation, and cross-language tests
- Phase 4 is complete (both plans executed)
- Ready for Phase 5 (Presence and Status) or Phase 6 (MCP Tool Packaging)

---
*Phase: 04-store-and-forward*
*Completed: 2026-02-27*
