---
phase: 09-skill-documentation-and-cli-optimization
plan: 01
subsystem: cli
tags: [bootstrap, relay, websocket, sqlite, cli-tools]

# Dependency graph
requires:
  - phase: 03-message-layer
    provides: bootstrap() pattern, ConnectionStore, MessageStore, CLI tools
  - phase: 05-autonomy-permissions
    provides: ActivityFeed, PermissionsEnforcer
  - phase: 06-audit-and-rate-limiting
    provides: pinch-audit-verify, pinch-audit-export tools
provides:
  - bootstrapLocal() function for relay-free CLI tool initialization
  - shutdownLocal() function for relay-free CLI tool cleanup
  - LocalBootstrapResult interface
affects: [cli-tools, skill-documentation]

# Tech tracking
tech-stack:
  added: []
  patterns: [bootstrapLocal singleton pattern for local-only CLI tools]

key-files:
  created: []
  modified:
    - skill/src/tools/cli.ts
    - skill/src/tools/pinch-permissions.ts
    - skill/src/tools/pinch-audit-verify.ts
    - skill/src/tools/pinch-audit-export.ts

key-decisions:
  - "Separate localBootstrapped singleton (not reusing bootstrapped) to avoid interference between local and full bootstrap"
  - "bootstrapLocal() placed after shutdown() for logical file organization (full bootstrap section, then local bootstrap section)"

patterns-established:
  - "bootstrapLocal pattern: tools that only need local data stores use bootstrapLocal()/shutdownLocal() instead of bootstrap()/shutdown()"

requirements-completed: [CLEANUP-09]

# Metrics
duration: 2min
completed: 2026-02-27
---

# Phase 09 Plan 01: Local Bootstrap for Relay-Free CLI Tools Summary

**bootstrapLocal()/shutdownLocal() functions added to cli.ts, eliminating unnecessary relay WebSocket connections in pinch-permissions, pinch-audit-verify, and pinch-audit-export**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-27T15:51:10Z
- **Completed:** 2026-02-27T15:53:10Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Added bootstrapLocal() function that initializes only local stores (keypair, ConnectionStore, MessageStore, ActivityFeed) without requiring PINCH_RELAY_URL or opening a WebSocket
- Added shutdownLocal() function that closes local stores without relay disconnect
- Updated pinch-permissions, pinch-audit-verify, and pinch-audit-export to use bootstrapLocal()/shutdownLocal()
- All 540 existing tests pass with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Add bootstrapLocal() and shutdownLocal() to cli.ts** - `adfafe4` (feat)
2. **Task 2: Update three local-only CLI tools to use bootstrapLocal()** - `5b0cba8` (feat)

## Files Created/Modified
- `skill/src/tools/cli.ts` - Added LocalBootstrapResult interface, bootstrapLocal() and shutdownLocal() functions
- `skill/src/tools/pinch-permissions.ts` - Switched from bootstrap/shutdown to bootstrapLocal/shutdownLocal
- `skill/src/tools/pinch-audit-verify.ts` - Switched from bootstrap/shutdown to bootstrapLocal/shutdownLocal
- `skill/src/tools/pinch-audit-export.ts` - Switched from bootstrap/shutdown to bootstrapLocal/shutdownLocal

## Decisions Made
- Separate `localBootstrapped` singleton variable (not reusing `bootstrapped`) to avoid interference between local and full bootstrap paths
- New functions placed after existing `shutdown()` for logical file organization

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Local-only CLI tools now start faster and work without a relay server
- Relay-dependent tools (pinch-send, pinch-connect, pinch-intervene, etc.) unchanged
- Phase 09 plan 01 is the only plan in this phase

## Self-Check: PASSED

All files exist. All commits verified.

---
*Phase: 09-skill-documentation-and-cli-optimization*
*Completed: 2026-02-27*
