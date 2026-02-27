---
phase: 02-authentication-and-connection
plan: 04
subsystem: connection
tags: [connection-lifecycle, protobuf, websocket, ed25519, block, revoke, integration-tests]

# Dependency graph
requires:
  - phase: 02-authentication-and-connection
    plan: 02
    provides: "bbolt block store, hub message routing with block enforcement"
  - phase: 02-authentication-and-connection
    plan: 03
    provides: "TypeScript auth handshake, RelayClient with auth, JSON-backed ConnectionStore"
provides:
  - "ConnectionManager with full lifecycle: request, approve, reject (silent), block, unblock, revoke"
  - "RelayClient sendEnvelope and onEnvelope methods for typed protobuf dispatch"
  - "End-to-end integration tests validating auth + connection flow across Go relay and TypeScript agents"
  - "Go hub auth integration tests with real WebSocket connections and Ed25519 handshake"
affects: [03-01, 03-02, 04-01]

# Tech tracking
tech-stack:
  added: []
  patterns: ["ConnectionManager orchestrates lifecycle via RelayClient sendEnvelope and ConnectionStore", "Silent rejection: no response sent on reject (indistinguishable from offline)", "setupHandlers dispatches incoming envelopes by MessageType via onEnvelope callback"]

key-files:
  created:
    - skill/src/connection.ts
    - skill/src/connection.test.ts
    - skill/src/connection.integration.test.ts
    - tests/cross-language/auth_handshake.sh
  modified:
    - skill/src/relay-client.ts
    - relay/internal/hub/hub_test.go

key-decisions:
  - "sendEnvelope delegates to existing send() method -- no new transport layer, just typed convenience"
  - "onEnvelope callback runs in parallel with onMessage (both fire for post-auth messages) to avoid breaking existing consumers"
  - "Silent rejection: rejectRequest updates local store to revoked but sends zero envelopes to requester"
  - "Block/unblock use relay-side enforcement via BlockNotification/UnblockNotification protobuf messages"

patterns-established:
  - "ConnectionManager constructor takes RelayClient + ConnectionStore (dependency injection for testability)"
  - "setupHandlers registers onEnvelope handler that dispatches by MessageType to lifecycle methods"
  - "Integration tests spawn real Go relay via go run, connect TypeScript agents, test full cross-language flow"
  - "Mock RelayClient pattern for unit testing: tracks sentEnvelopes array and envelopeCallback"

requirements-completed: [CONN-01, CONN-02, CONN-03, CONN-06]

# Metrics
duration: 7min
completed: 2026-02-27
---

# Phase 2 Plan 4: Connection Lifecycle Manager and Cross-Language Integration Tests Summary

**ConnectionManager with request/approve/reject(silent)/block(relay-enforced)/unblock(reversible)/revoke(notified) lifecycle, validated end-to-end across Go relay and TypeScript agents**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-27T02:33:23Z
- **Completed:** 2026-02-27T02:40:20Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Implemented ConnectionManager with all 10 lifecycle methods honoring every user decision from CONTEXT.md
- Added sendEnvelope/onEnvelope to RelayClient for typed protobuf message dispatch
- Created 20 unit tests covering all connection flows, silent rejection, autonomy defaults, and full request->approve->active lifecycle
- Added 5 Go hub integration tests with real Ed25519 auth handshake (success, bad signature, timeout, connection request routing, block enforcement)
- Created 4 cross-language integration tests validating auth handshake, connection request/approve, block/unblock enforcement, and revoke notification across Go relay and TypeScript agents
- All 71 TypeScript tests and 17 Go hub tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement ConnectionManager with full connection lifecycle** - `60bb6cc` (feat)
2. **Task 2: Cross-language integration tests for auth and connection lifecycle** - `9ec9129` (feat)

## Files Created/Modified
- `skill/src/connection.ts` - ConnectionManager: request, approve, reject (silent), block, unblock, revoke, handleIncoming*, setupHandlers
- `skill/src/connection.test.ts` - 20 unit tests: all lifecycle methods, full flows, autonomy defaults, setupHandlers dispatch
- `skill/src/connection.integration.test.ts` - 4 cross-language integration tests: auth handshake, connection request/approve, block/unblock, revoke
- `skill/src/relay-client.ts` - Added sendEnvelope, onEnvelope, envelopeHandler field, Envelope import
- `relay/internal/hub/hub_test.go` - 5 new auth integration tests: handshake success, bad signature, timeout, connection request routing, block enforcement via notification
- `tests/cross-language/auth_handshake.sh` - Bash wrapper for cross-language integration test execution

## Decisions Made
- **sendEnvelope delegates to send()**: No new transport layer needed -- sendEnvelope is a thin typed wrapper over the existing binary send method, keeping the RelayClient surface minimal.
- **onEnvelope runs alongside onMessage**: Both callbacks fire for post-auth messages to avoid breaking existing raw message consumers. The envelope handler catches and ignores protobuf parse errors for non-protobuf messages.
- **Silent rejection sends zero bytes**: rejectRequest only updates the local connection store to "revoked" state. No envelope is sent to the requester, making rejection indistinguishable from the recipient being offline (per locked CONTEXT.md decision).
- **Integration tests use setupHandlers**: The cross-language tests validate the full round-trip including the envelope dispatch system, not just individual methods.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full connection lifecycle is complete: agents can authenticate, request connections, approve/reject them, exchange keys, block/unblock, and revoke
- Phase 2 is fully complete -- all 4 plans executed, all requirements met (RELY-02, CONN-01 through CONN-06, AUTO-01, AUTO-02)
- Phase 3 (Skill Integration) can begin: ConnectionManager and ConnectionStore provide the data foundation for the MCP skill
- Phase 4 (Store-and-Forward) can begin: the relay routing and block enforcement are tested and operational
- 71 TypeScript tests and 17 Go hub tests provide comprehensive regression coverage

## Self-Check: PASSED

All key files verified present:
- skill/src/connection.ts: FOUND
- skill/src/connection.test.ts: FOUND
- skill/src/connection.integration.test.ts: FOUND
- skill/src/relay-client.ts: FOUND
- relay/internal/hub/hub_test.go: FOUND
- tests/cross-language/auth_handshake.sh: FOUND

All task commits verified in git log: 60bb6cc, 9ec9129.

---
*Phase: 02-authentication-and-connection*
*Completed: 2026-02-27*
