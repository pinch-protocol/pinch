---
phase: 05-full-autonomy-and-permissions
plan: 01
subsystem: autonomy
tags: [autonomy, activity-feed, sqlite, routing, cli-tool]

# Dependency graph
requires:
  - phase: 03-encrypted-messaging
    provides: InboundRouter 2-tier routing, ConnectionStore autonomy, MessageStore SQLite
provides:
  - 4-tier AutonomyLevel type (full_manual, notify, auto_respond, full_auto)
  - ActivityFeed SQLite-backed event persistence
  - 4-branch InboundRouter with notify and auto_respond routing
  - pinch-autonomy CLI tool for setting autonomy levels
  - getPendingPolicyEval() for Plan 02 PolicyEvaluator
  - circuitBreakerTripped field on Connection for Plan 03
affects: [05-02-policy-evaluator, 05-03-circuit-breaker]

# Tech tracking
tech-stack:
  added: []
  patterns: [4-tier autonomy switch routing, ActivityFeed event sourcing, shared SQLite via getDb()]

key-files:
  created:
    - skill/src/autonomy/activity-feed.ts
    - skill/src/autonomy/activity-feed.test.ts
    - skill/src/tools/pinch-autonomy.ts
    - skill/src/tools/pinch-autonomy.test.ts
  modified:
    - skill/src/connection-store.ts
    - skill/src/connection-store.test.ts
    - skill/src/inbound-router.ts
    - skill/src/inbound-router.test.ts
    - skill/src/message-store.ts
    - skill/src/tools/cli.ts
    - skill/src/index.ts
    - skill/package.json

key-decisions:
  - "ActivityFeed shares SQLite database via MessageStore.getDb() accessor (not private field access)"
  - "InboundRouter activityFeed parameter is optional (3rd param) for backward compatibility"
  - "Confirmation gate applies when upgrading TO full_auto from any level (not just from full_manual)"
  - "circuitBreakerTripped cleared on any setAutonomy call (human manually overriding)"

patterns-established:
  - "ActivityFeed event sourcing: record() with UUIDv7 IDs and getEvents() with filters"
  - "Shared SQLite access pattern: MessageStore.getDb() exposes underlying database for co-located tables"

requirements-completed: [AUTO-03, AUTO-04, AUTO-06, AUTO-07]

# Metrics
duration: 6min
completed: 2026-02-27
---

# Phase 5 Plan 01: Autonomy Tiers Summary

**4-tier autonomy system (full_manual/notify/auto_respond/full_auto) with SQLite activity feed, 4-branch InboundRouter, and pinch-autonomy CLI tool**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-27T06:08:28Z
- **Completed:** 2026-02-27T06:14:11Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments
- Extended AutonomyLevel from 2-state to 4-tier system with autoRespondPolicy and circuitBreakerTripped fields
- InboundRouter now routes all 4 autonomy levels: full_manual -> escalated_to_human, notify -> read_by_agent + activity feed, auto_respond -> pending_policy_eval, full_auto -> read_by_agent
- ActivityFeed class persists autonomy events in SQLite with UUIDv7 IDs and indexed queries
- pinch-autonomy CLI tool sets autonomy levels with confirmation gate for full_auto upgrades

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend AutonomyLevel to 4 tiers and add ActivityFeed** - `bc84a07` (feat)
2. **Task 2: Extend InboundRouter to 4-tier routing and create pinch-autonomy tool** - `715829e` (feat)

## Files Created/Modified
- `skill/src/connection-store.ts` - AutonomyLevel extended to 4 tiers, autoRespondPolicy and circuitBreakerTripped fields, updated setAutonomy
- `skill/src/connection-store.test.ts` - Tests for all 4 tiers, policy persistence, circuit breaker clearing
- `skill/src/autonomy/activity-feed.ts` - ActivityFeed class with SQLite persistence, UUIDv7 IDs, indexed queries
- `skill/src/autonomy/activity-feed.test.ts` - Table creation, record/retrieve, filtering, ordering, UUIDv7 tests
- `skill/src/inbound-router.ts` - 4-branch switch routing with ActivityFeed integration, getPendingPolicyEval method
- `skill/src/inbound-router.test.ts` - Tests for all 4 routing branches, mock ActivityFeed, policy eval queue
- `skill/src/tools/pinch-autonomy.ts` - CLI tool for setting autonomy level with --confirmed gate
- `skill/src/tools/pinch-autonomy.test.ts` - parseArgs tests for all arguments and validation
- `skill/src/message-store.ts` - Added getDb() public accessor for shared SQLite database
- `skill/src/tools/cli.ts` - ActivityFeed wired into bootstrap
- `skill/src/index.ts` - Export ActivityFeed and ActivityEvent
- `skill/package.json` - Added pinch-autonomy bin entry

## Decisions Made
- ActivityFeed shares the same SQLite database instance via MessageStore.getDb() accessor rather than private field access for type safety
- InboundRouter's ActivityFeed parameter is optional (3rd constructor param) to maintain backward compatibility with existing code
- Confirmation gate was broadened: applies when upgrading TO full_auto from any level (not just from full_manual as in Phase 2)
- circuitBreakerTripped is cleared on any setAutonomy() call, representing the human manually overriding the circuit breaker

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ActivityFeed DESC ordering test flakiness**
- **Found during:** Task 1
- **Issue:** Two events recorded in the same millisecond had identical timestamps but different UUIDv7 IDs, making ORDER BY created_at DESC non-deterministic
- **Fix:** Added 10ms delay between event recordings to ensure different timestamps
- **Files modified:** skill/src/autonomy/activity-feed.test.ts
- **Verification:** Test passes consistently
- **Committed in:** bc84a07 (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added MessageStore.getDb() accessor**
- **Found during:** Task 2
- **Issue:** ActivityFeed needs the same SQLite database instance but MessageStore.db is private; bracket notation access violates TypeScript strict mode
- **Fix:** Added public getDb() method to MessageStore for type-safe shared database access
- **Files modified:** skill/src/message-store.ts
- **Verification:** cli.ts compiles and all 165 tests pass
- **Committed in:** 715829e (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- 4-tier autonomy type system ready for Plan 02 (PolicyEvaluator) and Plan 03 (Circuit Breaker)
- getPendingPolicyEval() method ready for PolicyEvaluator consumption
- circuitBreakerTripped field ready for circuit breaker logic
- ActivityFeed ready for recording circuit breaker events

---
*Phase: 05-full-autonomy-and-permissions*
*Completed: 2026-02-27*
