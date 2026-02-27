---
phase: 04-store-and-forward
plan: 01
subsystem: database
tags: [bbolt, protobuf, message-queue, store-and-forward, ttl]

# Dependency graph
requires:
  - phase: 03-encrypted-messaging
    provides: "DeliveryConfirm message, BlockStore with bbolt, relay hub with routing"
provides:
  - "QueueStatus and QueueFull proto messages for store-and-forward signaling"
  - "was_stored flag on DeliveryConfirm for delayed delivery indication"
  - "Shared OpenDB for bbolt handle reuse across stores"
  - "MessageQueue store with enqueue, flush, remove, count, sweep operations"
  - "1,000-message per-agent cap with ErrQueueFull sentinel error"
  - "TTL-based expiration via background sweep goroutine"
affects: [04-store-and-forward, relay-hub-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared bbolt DB handle pattern (OpenDB + pass *bolt.DB to stores)"
    - "Per-recipient nested bucket with big-endian timestamp keys for ordered retrieval"
    - "Two-pass collect-then-delete for bbolt cursor safety"
    - "JSON-encoded queue values for human-debuggable bbolt inspection"

key-files:
  created:
    - "relay/internal/store/db.go"
    - "relay/internal/store/messagequeue.go"
    - "relay/internal/store/messagequeue_test.go"
  modified:
    - "proto/pinch/v1/envelope.proto"
    - "gen/go/pinch/v1/envelope.pb.go"
    - "gen/ts/pinch/v1/envelope_pb.ts"
    - "relay/internal/store/blockstore.go"
    - "relay/internal/store/blockstore_test.go"
    - "relay/internal/hub/hub_test.go"
    - "relay/cmd/pinchd/main.go"

key-decisions:
  - "BlockStore.Close() removed -- caller (main.go) owns and closes the shared DB handle"
  - "JSON encoding for queue values (human-debuggable, small payloads, write path serialized by bbolt)"
  - "5-minute sweep interval hardcoded (with 7-day TTL, granularity is negligible)"
  - "Corrupt entries in FlushBatch are skipped with slog.Warn, cleaned by sweep"

patterns-established:
  - "Shared DB pattern: OpenDB returns *bolt.DB, all stores receive shared handle"
  - "Nested bucket pattern: top-level bucket per store, nested per-entity sub-buckets"
  - "Ordered key encoding: 16-byte [8-byte big-endian nanos][8-byte big-endian seq]"

requirements-completed: [RELY-05]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 4 Plan 1: Store-and-Forward Persistence Layer Summary

**bbolt MessageQueue with per-recipient nested buckets, 1,000-message cap, 7-day TTL sweep, and shared DB handle pattern across BlockStore and MessageQueue**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-27T05:05:15Z
- **Completed:** 2026-02-27T05:10:54Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Proto schema extended with QueueStatus, QueueFull messages, was_stored flag, and two new MessageType enum values
- Shared bbolt database opener extracted into db.go; BlockStore refactored to accept *bolt.DB instead of path
- MessageQueue implements full CRUD: Enqueue, FlushBatch, Remove, Count, Sweep, StartSweep
- 13 comprehensive unit tests covering all MessageQueue operations plus shared DB coexistence with BlockStore

## Task Commits

Each task was committed atomically:

1. **Task 1: Proto schema extensions and shared DB extraction** - `90213c5` (feat)
2. **Task 2: MessageQueue store implementation with unit tests** - `e52fd13` (test)

## Files Created/Modified
- `proto/pinch/v1/envelope.proto` - Added QueueStatus, QueueFull messages, was_stored, new enum values
- `gen/go/pinch/v1/envelope.pb.go` - Regenerated Go protobuf code with new types
- `gen/ts/pinch/v1/envelope_pb.ts` - Regenerated TypeScript protobuf code with new types
- `relay/internal/store/db.go` - Shared bbolt database opener (OpenDB)
- `relay/internal/store/blockstore.go` - Refactored to accept *bolt.DB, removed Close()
- `relay/internal/store/blockstore_test.go` - Updated for shared DB pattern
- `relay/internal/hub/hub_test.go` - Updated 3 test helpers for shared DB pattern
- `relay/internal/store/messagequeue.go` - MessageQueue store with enqueue, flush, remove, count, sweep
- `relay/internal/store/messagequeue_test.go` - 13 unit tests for all MessageQueue operations
- `relay/cmd/pinchd/main.go` - Uses OpenDB, creates both stores, MessageQueue ready for Plan 02

## Decisions Made
- BlockStore.Close() removed entirely -- the shared DB handle is owned and closed by the caller (main.go via defer db.Close())
- JSON encoding chosen for queue values over binary/gob for human debuggability with bbolt CLI tools
- 5-minute sweep interval hardcoded as recommended by research (with 7-day TTL, finer granularity wastes write transactions)
- Corrupt entries in FlushBatch skipped with slog.Warn rather than deleted (sweep handles cleanup or leaves for manual inspection)
- Hub test helpers updated as blocking deviation (Rule 3) since they called old NewBlockStore(path) signature

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated hub_test.go for shared DB pattern**
- **Found during:** Task 1 (shared DB extraction)
- **Issue:** Three test helpers in hub_test.go called NewBlockStore(dbPath) with old path-based signature, preventing compilation
- **Fix:** Updated all three helpers to use OpenDB(dbPath) + NewBlockStore(db) pattern with db.Close() in cleanup
- **Files modified:** relay/internal/hub/hub_test.go
- **Verification:** go test ./relay/internal/hub/... passes all 21 tests
- **Committed in:** 90213c5 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required fix for compilation. The plan mentioned hub_test.go changes happen in Plan 02, but the BlockStore signature change made these updates immediately necessary.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- MessageQueue store is fully implemented and tested, ready for hub integration in Plan 02
- main.go creates MessageQueue instance (currently unused) -- Plan 02 will wire it into hub.NewHub and RouteMessage
- Proto schema has all message types needed for queue status signaling and queue full errors

---
*Phase: 04-store-and-forward*
*Completed: 2026-02-27*
