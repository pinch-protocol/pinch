---
phase: 06-oversight-and-safety
plan: 03
subsystem: messaging
tags: [passthrough, mute, attribution, intervention, oversight, enforcement-pipeline]

# Dependency graph
requires:
  - phase: 06-01
    provides: "ActivityFeed with hash-chained audit log, event recording API"
provides:
  - "pinch-intervene CLI tool for entering/exiting passthrough mode and sending human-attributed messages"
  - "pinch-mute CLI tool for muting/unmuting connections"
  - "Connection.muted and Connection.passthrough fields"
  - "Enforcement pipeline mute/passthrough short-circuits before permissions check"
  - "Message attribution (agent/human) via structured JSON wrapper in PlaintextPayload"
  - "clearPassthroughFlags() on bootstrap for session safety"
affects: [06-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Structured content wrapper: application/x-pinch+json content type with JSON {text, attribution} envelope"
    - "Pre-pipeline short-circuit: muted and passthrough checks run before permissions/circuit breaker to avoid false triggers"
    - "Bootstrap safety clear: clearPassthroughFlags() prevents stuck state across disconnects"

key-files:
  created:
    - "skill/src/tools/pinch-intervene.ts"
    - "skill/src/tools/pinch-intervene.test.ts"
    - "skill/src/tools/pinch-mute.ts"
    - "skill/src/tools/pinch-mute.test.ts"
  modified:
    - "skill/src/connection-store.ts"
    - "skill/src/autonomy/enforcement-pipeline.ts"
    - "skill/src/autonomy/enforcement-pipeline.test.ts"
    - "skill/src/message-manager.ts"
    - "skill/src/tools/cli.ts"

key-decisions:
  - "Mute check runs before passthrough check, which runs before permissions check (Step 0, 0b, then 1)"
  - "Muted + passthrough: mute takes precedence since mute check is first in pipeline"
  - "clearPassthroughFlags() is async and calls save() to persist the cleared state to disk"
  - "Structured content uses application/x-pinch+json content type as forward-compatible signal"
  - "Receivers that do not understand x-pinch+json see raw JSON string as body (acceptable per research)"

patterns-established:
  - "Pre-pipeline short-circuit pattern: checks that bypass entire enforcement pipeline (mute, passthrough) go before Step 1"
  - "Message attribution wrapper: JSON {text, attribution} in PlaintextPayload with application/x-pinch+json content type"

requirements-completed: [OVRS-03, OVRS-04, CONN-05]

# Metrics
duration: 12min
completed: 2026-02-27
---

# Phase 6 Plan 3: Human Intervention, Attribution, and Muting Summary

**Passthrough mode (pinch-intervene) and mute (pinch-mute) tools with structured message attribution via application/x-pinch+json content wrapper**

## Performance

- **Duration:** 12 min
- **Started:** 2026-02-27T08:00:25Z
- **Completed:** 2026-02-27T08:13:03Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Connection interface extended with muted and passthrough fields, enforcement pipeline short-circuits both before permissions/circuit breaker
- pinch-intervene tool enables human passthrough mode (--start/--stop) and human-attributed message sending (--send)
- pinch-mute tool enables silent connection muting -- messages still delivered (confirmations sent) but not surfaced
- Message attribution (agent/human) embedded in structured JSON wrapper with forward-compatible content type
- Bootstrap safety: passthrough flags cleared on startup to prevent stuck passthrough after disconnect

## Task Commits

Each task was committed atomically:

1. **Task 1: Add muted/passthrough fields, implement in enforcement pipeline** - `3b8a93c` (feat)
2. **Task 2: Create pinch-intervene and pinch-mute tools with message attribution** - `83e0776` (feat)

## Files Created/Modified
- `skill/src/connection-store.ts` - Added muted/passthrough fields, updateConnection Pick<> extension, clearPassthroughFlags()
- `skill/src/autonomy/enforcement-pipeline.ts` - Added Step 0 mute check and Step 0b passthrough check before permissions
- `skill/src/autonomy/enforcement-pipeline.test.ts` - Added 4 test cases for mute, passthrough, precedence, and clearPassthroughFlags
- `skill/src/message-manager.ts` - Added attribution to SendMessageParams, structured JSON content wrapper, inbound attribution parsing
- `skill/src/tools/cli.ts` - Added clearPassthroughFlags() call in bootstrap()
- `skill/src/tools/pinch-intervene.ts` - New CLI tool for passthrough mode and human-attributed sending
- `skill/src/tools/pinch-intervene.test.ts` - 7 parseArgs test cases
- `skill/src/tools/pinch-mute.ts` - New CLI tool for muting/unmuting connections
- `skill/src/tools/pinch-mute.test.ts` - 4 parseArgs test cases

## Decisions Made
- Mute check runs as Step 0 (before everything) to avoid triggering circuit breakers on muted connections
- Muted + passthrough: mute takes precedence (mute check is first in pipeline order)
- clearPassthroughFlags() is async and persists to disk immediately
- Structured content uses application/x-pinch+json content type; receivers not understanding it see raw JSON (acceptable forward-compat)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Intervention and muting capabilities ready for use by oversight dashboard
- Plan 06-04 can proceed with remaining safety features
- All 31 tests passing across 4 test files

## Self-Check: PASSED

All 10 files verified present. Both commits (3b8a93c, 83e0776) verified in git log. 31 tests passing.

---
*Phase: 06-oversight-and-safety*
*Completed: 2026-02-27*
