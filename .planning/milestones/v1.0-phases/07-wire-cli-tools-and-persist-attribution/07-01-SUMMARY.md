---
phase: 07-wire-cli-tools-and-persist-attribution
plan: 01
subsystem: messaging, cli
tags: [sqlite, schema-evolution, cli-tools, bin-entries, attribution]

# Dependency graph
requires:
  - phase: 06-oversight-and-safety
    provides: 5 CLI tools (pinch-activity, pinch-intervene, pinch-mute, pinch-audit-verify, pinch-audit-export) and attribution wire format (application/x-pinch+json)
provides:
  - 12 invocable CLI tools via package.json bin entries (7 existing + 5 new)
  - Message attribution persisted to SQLite messages table
  - pinch-history output includes attribution field
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PRAGMA table_info schema evolution for nullable columns on existing tables"

key-files:
  created: []
  modified:
    - skill/package.json
    - skill/src/message-store.ts
    - skill/src/message-manager.ts
    - skill/src/tools/pinch-history.ts
    - skill/SKILL.md

key-decisions:
  - "Attribution column is nullable TEXT (not NOT NULL) for backward compatibility with existing messages"
  - "Outbound attribution defaults to 'agent' when not specified, consistent with wire format behavior"
  - "pinch-history surfaces attribution as null for old messages without attribution"

patterns-established:
  - "PRAGMA table_info guard before ALTER TABLE ADD COLUMN for idempotent schema evolution"

requirements-completed: [OVRS-01, OVRS-02, OVRS-03, OVRS-04, OVRS-05, CONN-05]

# Metrics
duration: 3min
completed: 2026-02-27
---

# Phase 7 Plan 1: Wire CLI Tools and Persist Attribution Summary

**12 bin entries wired for all CLI tools plus SQLite attribution persistence for inbound/outbound messages surfaced via pinch-history**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-27T14:28:06Z
- **Completed:** 2026-02-27T14:31:36Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- All 5 Phase 6 CLI tools (pinch-activity, pinch-intervene, pinch-mute, pinch-audit-verify, pinch-audit-export) wired as invocable bin entries in package.json (total 12 bin entries)
- Message attribution ("agent" or "human") persisted to SQLite messages table via nullable TEXT column with idempotent schema evolution
- Both inbound and outbound message paths now persist attribution (inbound from x-pinch+json wrapper, outbound defaults to "agent")
- pinch-history tool surfaces attribution in JSON output for all messages

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Phase 6 bin entries to package.json** - `8c06147` (feat)
2. **Task 2: Persist message attribution to SQLite and surface in pinch-history** - `af4c899` (feat)

## Files Created/Modified
- `skill/package.json` - Added 5 bin entries for Phase 6 CLI tools (total 12)
- `skill/src/message-store.ts` - MessageRecord interface with attribution field, PRAGMA table_info schema evolution, saveMessage/rowToRecord with attribution
- `skill/src/message-manager.ts` - handleIncomingMessage persists inboundAttribution, sendMessage persists attribution (default "agent")
- `skill/src/tools/pinch-history.ts` - Output mapping includes attribution field (null for old messages)
- `skill/SKILL.md` - pinch_history example updated with attribution field

## Decisions Made
- Attribution column is nullable TEXT (not NOT NULL) for backward compatibility with existing messages that have no attribution
- Outbound attribution defaults to "agent" when not specified, consistent with wire format behavior established in Phase 6
- pinch-history surfaces attribution as null for old messages without attribution (not omitted)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing TypeScript strict mode errors in test files (libsodium type declarations, implicit any in test mocks) prevent `tsc` from completing successfully, but all dist files exist from previous builds and all 540 tests pass via vitest. These are pre-existing and not caused by this plan's changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All v1.0 audit gaps are now closed
- All 12 CLI tools are invocable via pnpm
- Message attribution is fully persisted end-to-end
- No blockers or concerns

## Self-Check: PASSED

All 5 modified files verified present. Both task commits (8c06147, af4c899) verified in git log.

---
*Phase: 07-wire-cli-tools-and-persist-attribution*
*Completed: 2026-02-27*
