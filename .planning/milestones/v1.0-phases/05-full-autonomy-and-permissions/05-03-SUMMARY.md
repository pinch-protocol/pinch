---
phase: 05-full-autonomy-and-permissions
plan: 03
subsystem: autonomy
tags: [circuit-breaker, enforcement-pipeline, safety, sliding-window, permissions]

# Dependency graph
requires:
  - phase: 05-full-autonomy-and-permissions
    provides: 4-tier AutonomyLevel, ActivityFeed, InboundRouter, PermissionsEnforcer, PolicyEvaluator, ConnectionStore autonomy fields
provides:
  - CircuitBreaker with sliding window counters for 4 trigger types (message_flood, permission_violation, spending_exceeded, boundary_probe)
  - EnforcementPipeline wiring permissions -> circuit breaker -> autonomy routing -> policy evaluation
  - Auto-respond policy evaluation with safe fallbacks and activity feed logging
  - Updated bootstrap creating all autonomy components
  - MessageManager routing through enforcementPipeline.process() instead of inboundRouter.route()
  - Complete SKILL.md documentation for all 4 autonomy levels, permissions, tools, and circuit breakers
affects: [phase-06-agent-runtime]

# Tech tracking
tech-stack:
  added: []
  patterns: [sliding window counter for rate detection, enforcement pipeline orchestration, circuit breaker auto-downgrade with persisted trip flag]

key-files:
  created:
    - skill/src/autonomy/circuit-breaker.ts
    - skill/src/autonomy/circuit-breaker.test.ts
    - skill/src/autonomy/enforcement-pipeline.ts
    - skill/src/autonomy/enforcement-pipeline.test.ts
  modified:
    - skill/src/tools/cli.ts
    - skill/src/message-manager.ts
    - skill/src/message-manager.test.ts
    - skill/src/message-manager.integration.test.ts
    - skill/src/index.ts
    - skill/SKILL.md
    - skill/HEARTBEAT.md

key-decisions:
  - "EnforcementPipeline is the single entry point for all inbound message processing after decryption"
  - "Circuit breaker uses updateConnection() for downgrade to avoid setAutonomy() confirmation gate for full_auto"
  - "Auto-respond policy evaluation logs every decision to activity feed regardless of outcome (allow, deny, escalate, error)"
  - "Circuit breaker trip calls connectionStore.save() as fire-and-forget for persistence"

patterns-established:
  - "Enforcement pipeline pattern: permissions -> circuit breaker -> autonomy routing -> policy evaluation as single process() call"
  - "Sliding window counter: in-memory event arrays pruned by longest window, thresholds checked per trigger type"
  - "Safe default escalation: LLM unavailability, no policy configured, and uncertainty all escalate to human"

requirements-completed: [AUTO-10]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 5 Plan 03: Circuit Breakers and Enforcement Pipeline Summary

**CircuitBreaker with 4 sliding-window triggers auto-downgrading to Full Manual, EnforcementPipeline orchestrating permissions->circuit breaker->routing->policy evaluation as single entry point for all inbound messages**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-27T06:23:47Z
- **Completed:** 2026-02-27T06:29:38Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- CircuitBreaker tracks 4 trigger types (message_flood, permission_violation, spending_exceeded, boundary_probe) with configurable sliding window thresholds and auto-downgrades to Full Manual
- EnforcementPipeline orchestrates the complete inbound message processing flow: permissions check, circuit breaker recording, autonomy routing, and auto-respond policy evaluation
- MessageManager now routes all inbound messages through enforcementPipeline.process() instead of calling inboundRouter.route() directly
- Bootstrap creates all autonomy components (ActivityFeed, PermissionsEnforcer, CircuitBreaker, EnforcementPipeline) and wires them together
- SKILL.md fully documents all 4 autonomy levels, permissions manifest, pinch-autonomy tool, pinch-permissions tool, and circuit breakers

## Task Commits

Each task was committed atomically:

1. **Task 1: Create CircuitBreaker and EnforcementPipeline** - `a92ac34` (feat)
2. **Task 2: Wire enforcement pipeline into bootstrap and message flow, update skill docs** - `90dbefe` (feat)

## Files Created/Modified
- `skill/src/autonomy/circuit-breaker.ts` - CircuitBreaker class with sliding window counters for 4 trigger types
- `skill/src/autonomy/circuit-breaker.test.ts` - 9 tests: threshold behavior, event pruning, trip persistence, activity feed logging, human re-upgrade
- `skill/src/autonomy/enforcement-pipeline.ts` - EnforcementPipeline class orchestrating permissions -> circuit breaker -> routing -> policy evaluation
- `skill/src/autonomy/enforcement-pipeline.test.ts` - 10 tests: all pipeline paths including permissions denial, circuit breaker trip, auto-respond allow/deny/escalate/error
- `skill/src/tools/cli.ts` - Bootstrap creates all autonomy components and wires EnforcementPipeline to MessageManager
- `skill/src/message-manager.ts` - Constructor accepts EnforcementPipeline instead of InboundRouter; routes via enforcementPipeline.process()
- `skill/src/message-manager.test.ts` - Updated to use mock EnforcementPipeline for MessageManager constructor
- `skill/src/message-manager.integration.test.ts` - Updated to construct full autonomy pipeline for integration tests
- `skill/src/index.ts` - Exports CircuitBreaker, CircuitBreakerConfig, TriggerType, DEFAULT_CIRCUIT_BREAKER_CONFIG, EnforcementPipeline
- `skill/SKILL.md` - Documents all 4 autonomy levels, permissions manifest, pinch-autonomy, pinch-permissions, circuit breakers
- `skill/HEARTBEAT.md` - Added circuit breaker and auto-respond monitoring items

## Decisions Made
- EnforcementPipeline is the single entry point for all inbound message processing -- replacing the direct inboundRouter.route() call in MessageManager
- Circuit breaker uses updateConnection() (not setAutonomy()) for the downgrade to avoid triggering the confirmation gate that setAutonomy() enforces for full_auto upgrades
- Auto-respond policy evaluation logs every decision to the activity feed regardless of outcome (allow, deny, escalate, or error) -- satisfying AUTO-05's "logs everything" requirement
- Circuit breaker trip calls connectionStore.save() as fire-and-forget since save() is async but the trip detection is synchronous within the pipeline flow

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated integration test to use EnforcementPipeline constructor**
- **Found during:** Task 2 (full regression test suite)
- **Issue:** message-manager.integration.test.ts creates MessageManager with the old InboundRouter parameter, causing "this.enforcementPipeline.process is not a function" errors
- **Fix:** Updated createAgent() to construct the full autonomy pipeline (ActivityFeed, PermissionsEnforcer, CircuitBreaker, EnforcementPipeline) and pass enforcementPipeline to MessageManager
- **Files modified:** skill/src/message-manager.integration.test.ts
- **Verification:** All 221 tests pass including all 5 integration tests
- **Committed in:** 90dbefe (Task 2 commit)

**2. [Rule 3 - Blocking] Updated unit test to use mock EnforcementPipeline**
- **Found during:** Task 2 (full regression test suite)
- **Issue:** message-manager.test.ts creates MessageManager with InboundRouter, incompatible with new constructor signature
- **Fix:** Created mock EnforcementPipeline with process() method returning escalated_to_human state
- **Files modified:** skill/src/message-manager.test.ts
- **Verification:** All 221 tests pass
- **Committed in:** 90dbefe (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking -- test signature updates)
**Impact on plan:** Both fixes necessary for test compatibility after constructor change. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 5 complete: full autonomy system with 4 tiers, permissions manifest, policy evaluation, and circuit breakers
- EnforcementPipeline is the single entry point for all inbound message processing
- CircuitBreaker protects against anomalous behavior with configurable thresholds
- All 221 tests pass across the entire skill codebase
- SKILL.md fully documents all tools and behaviors for agent consumption

---
*Phase: 05-full-autonomy-and-permissions*
*Completed: 2026-02-27*
