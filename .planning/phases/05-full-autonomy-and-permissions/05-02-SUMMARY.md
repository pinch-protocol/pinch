---
phase: 05-full-autonomy-and-permissions
plan: 02
subsystem: autonomy
tags: [permissions, policy-evaluator, information-boundaries, deny-by-default, cli-tool]

# Dependency graph
requires:
  - phase: 05-full-autonomy-and-permissions
    provides: 4-tier AutonomyLevel, ActivityFeed, InboundRouter, ConnectionStore autonomy fields
provides:
  - PermissionsManifest type with domain-specific capability tiers (calendar, files, actions, spending, boundaries, custom categories)
  - defaultPermissionsManifest() deny-all factory
  - PermissionsEnforcer gating content before autonomy routing
  - PolicyEvaluator interface for injectable LLM-evaluated policy decisions
  - NoOpPolicyEvaluator safe fallback when LLM unavailable
  - pinch-permissions CLI tool for manifest configuration
  - ConnectionStore.setPermissions() with validation
affects: [05-03-circuit-breaker]

# Tech tracking
tech-stack:
  added: []
  patterns: [deny-by-default permissions manifest, injectable PolicyEvaluator interface, LLM-unavailability safe fallback]

key-files:
  created:
    - skill/src/autonomy/permissions-manifest.ts
    - skill/src/autonomy/permissions-manifest.test.ts
    - skill/src/autonomy/permissions-enforcer.ts
    - skill/src/autonomy/permissions-enforcer.test.ts
    - skill/src/autonomy/policy-evaluator.ts
    - skill/src/autonomy/policy-evaluator.test.ts
    - skill/src/tools/pinch-permissions.ts
    - skill/src/tools/pinch-permissions.test.ts
  modified:
    - skill/src/connection-store.ts
    - skill/src/index.ts
    - skill/package.json

key-decisions:
  - "Deny-all manifest assigned to new connections via defaultPermissionsManifest() in addConnection()"
  - "Plain text messages pass structural check in v1 (future phases add structured action types)"
  - "Custom category check reuses checkInformationBoundary with category description as boundary"
  - "LLM failure or uncertainty always escalates to human (safe default per research pitfall 5)"

patterns-established:
  - "Injectable PolicyEvaluator interface: LLM evaluation decoupled from business logic for testability"
  - "MockPolicyEvaluator pattern for testing LLM-dependent enforcement without real LLM calls"
  - "Permissions manifest validation via validateManifest() before persistence"

requirements-completed: [AUTO-05, AUTO-08, AUTO-09]

# Metrics
duration: 4min
completed: 2026-02-27
---

# Phase 5 Plan 02: Permissions Manifest and Enforcement Summary

**Deny-by-default permissions manifest with domain-specific capability tiers, LLM-evaluated information boundaries via injectable PolicyEvaluator, and pinch-permissions CLI tool**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-27T06:16:55Z
- **Completed:** 2026-02-27T06:21:18Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- PermissionsManifest type defines all domain-specific capability tiers: calendar (4 levels), files (3 levels), actions (3 levels), spending caps, information boundaries, and custom categories
- PermissionsEnforcer gates content before autonomy routing with LLM-evaluated information boundary checks and safe fallback on LLM unavailability
- PolicyEvaluator interface enables injectable LLM evaluation with NoOpPolicyEvaluator safe fallback
- New connections automatically get deny-all manifest (Pinch core trust principle)
- pinch-permissions CLI tool for viewing and modifying permission manifests

## Task Commits

Each task was committed atomically:

1. **Task 1: Create PermissionsManifest type, PermissionsEnforcer, and PolicyEvaluator interface** - `8daecdc` (feat)
2. **Task 2: Create pinch-permissions tool and update exports** - `cac386e` (feat)

## Files Created/Modified
- `skill/src/autonomy/permissions-manifest.ts` - PermissionsManifest type, defaultPermissionsManifest(), validateManifest()
- `skill/src/autonomy/permissions-manifest.test.ts` - Tests for deny-all defaults, validation errors
- `skill/src/autonomy/permissions-enforcer.ts` - PermissionsEnforcer class with structural + LLM boundary checks
- `skill/src/autonomy/permissions-enforcer.test.ts` - Tests with MockPolicyEvaluator for all enforcement paths
- `skill/src/autonomy/policy-evaluator.ts` - PolicyEvaluator interface, PolicyDecision type, NoOpPolicyEvaluator
- `skill/src/autonomy/policy-evaluator.test.ts` - NoOpPolicyEvaluator returns escalate for all evaluations
- `skill/src/tools/pinch-permissions.ts` - CLI tool for viewing/modifying permissions manifests
- `skill/src/tools/pinch-permissions.test.ts` - parseArgs tests for all CLI arguments
- `skill/src/connection-store.ts` - Added permissionsManifest field, setPermissions() method, deny-all default
- `skill/src/index.ts` - Exports for all new autonomy types and classes
- `skill/package.json` - Added pinch-permissions bin entry

## Decisions Made
- Deny-all manifest is assigned automatically to new connections in addConnection(), enforcing the Pinch deny-by-default core principle at the data layer
- In v1, plain text messages pass the structural check since Pinch messages are encrypted plaintext (not structured action types yet); information boundaries provide the primary gating mechanism
- Custom category enforcement reuses the checkInformationBoundary method with the category description as a boundary, keeping the interface simple
- All LLM failures and uncertainty outcomes result in escalation to human, following the safe default per research pitfall 5 (LLM unavailability)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- PermissionsManifest and PermissionsEnforcer ready for integration into message pipeline
- PolicyEvaluator interface ready for real LLM implementation injection by agent runtime
- Circuit breaker (Plan 03) can record permission violations via ActivityFeed
- All 202 tests pass with zero regressions

---
*Phase: 05-full-autonomy-and-permissions*
*Completed: 2026-02-27*
