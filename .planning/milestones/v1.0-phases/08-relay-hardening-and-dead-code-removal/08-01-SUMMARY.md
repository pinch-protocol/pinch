---
phase: 08-relay-hardening-and-dead-code-removal
plan: 01
subsystem: relay
tags: [websocket, security, dead-code-removal, go]

# Dependency graph
requires:
  - phase: 04-store-and-forward
    provides: "Flush strategy decision (immediate deletion, not delivery-confirm)"
provides:
  - "Clean relay hub without dead flush key correlation code"
  - "Environment-gated WebSocket origin verification via PINCH_RELAY_DEV"
affects: [deployment, relay-configuration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Environment variable gating for development-only features"

key-files:
  created: []
  modified:
    - relay/internal/hub/client.go
    - relay/internal/hub/hub.go
    - relay/cmd/pinchd/main.go

key-decisions:
  - "PINCH_RELAY_DEV=1 gates InsecureSkipVerify (production defaults to secure)"
  - "Dead flush key code removed entirely (superseded by Phase 4 immediate-deletion strategy)"

patterns-established:
  - "Dev-mode gating: PINCH_RELAY_DEV=1 env var pattern for development convenience features"

requirements-completed: [RELY-06]

# Metrics
duration: 2min
completed: 2026-02-27
---

# Phase 8 Plan 1: Relay Hardening and Dead Code Removal Summary

**Removed dead TrackFlushKey/PopFlushKey flush correlation code and gated InsecureSkipVerify behind PINCH_RELAY_DEV=1 env var for secure production defaults**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-27T15:23:45Z
- **Completed:** 2026-02-27T15:26:18Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Removed dead flush key tracking code (flushKeys map, flushMu mutex, TrackFlushKey/PopFlushKey methods, delivery-confirm correlation block) from relay hub
- Gated WebSocket InsecureSkipVerify behind PINCH_RELAY_DEV=1 environment variable so production enforces origin verification by default
- All 83 existing relay tests pass with zero changes to test code

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove dead TrackFlushKey/PopFlushKey code** - `b20e072` (fix)
2. **Task 2: Gate InsecureSkipVerify behind PINCH_RELAY_DEV** - `2e713c4` (feat)

## Files Created/Modified
- `relay/internal/hub/client.go` - Removed flushKeys/flushMu fields and TrackFlushKey/PopFlushKey methods; removed unused "sync" import
- `relay/internal/hub/hub.go` - Removed delivery-confirm flush correlation block; removed unused "encoding/hex" import
- `relay/cmd/pinchd/main.go` - Added PINCH_RELAY_DEV env var reading, devMode parameter threading to wsHandler, InsecureSkipVerify gating

## Decisions Made
- PINCH_RELAY_DEV=1 is the env var pattern for development mode (consistent with existing PINCH_RELAY_* naming)
- Dead flush key code removed entirely rather than deprecated (superseded by Phase 4-02 immediate-deletion strategy; zero callers remain)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. Existing deployments default to secure (InsecureSkipVerify: false). Set PINCH_RELAY_DEV=1 for development environments that need cross-origin WebSocket connections.

## Next Phase Readiness
- Relay codebase is cleaner with no dead code
- Production defaults enforce origin verification
- Ready for any subsequent relay hardening plans in Phase 8

## Self-Check: PASSED

- All 3 modified files exist on disk
- Task 1 commit `b20e072` verified in git log
- Task 2 commit `2e713c4` verified in git log
- SUMMARY.md created at expected path

---
*Phase: 08-relay-hardening-and-dead-code-removal*
*Completed: 2026-02-27*
