---
phase: 02-authentication-and-connection
plan: 03
subsystem: auth
tags: [ed25519, challenge-response, libsodium, websocket, connection-store, autonomy, json-persistence]

# Dependency graph
requires:
  - phase: 01-foundation-and-crypto-primitives
    provides: "Ed25519 identity, libsodium crypto, protobuf schema, WebSocket relay client"
  - phase: 02-authentication-and-connection
    plan: 01
    provides: "Protobuf auth messages (AuthChallenge/AuthResponse/AuthResult), relay auth module with challenge-response handshake"
provides:
  - "TypeScript auth module with signChallenge for Ed25519 nonce signing"
  - "Rewritten RelayClient with cryptographic auth handshake (no more ?address= query param)"
  - "JSON-backed ConnectionStore with all connection lifecycle states and autonomy levels"
  - "Data-layer gate on full_manual -> full_auto upgrade requiring explicit confirmation"
affects: [02-04, 03-01, 03-02]

# Tech tracking
tech-stack:
  added: []
  patterns: ["RelayClient takes Keypair instead of address string -- address is relay-assigned after auth", "ConnectionStore as JSON file with state priority sorting", "Autonomy confirmation gate at data layer (UX deferred to Phase 3)"]

key-files:
  created:
    - skill/src/auth.ts
    - skill/src/auth.test.ts
    - skill/src/connection-store.ts
    - skill/src/connection-store.test.ts
  modified:
    - skill/src/relay-client.ts
    - skill/src/relay-client.test.ts

key-decisions:
  - "signChallenge is async (calls ensureSodiumReady internally) -- caller doesn't need to manage sodium initialization"
  - "RelayClient auth handshake uses state machine (awaiting_challenge -> awaiting_result -> done) to process sequential binary messages"
  - "Connection store sorts by state priority (active > pending_inbound > pending_outbound > revoked > blocked) then lastActivity descending"
  - "Blocking is reversible -- blocked -> active state transition is allowed (unblock restores connection)"

patterns-established:
  - "Auth handshake: RelayClient receives AuthChallenge, signs nonce with Ed25519 private key, sends AuthResponse with signature + public key, receives AuthResult with assigned pinch: address"
  - "Connection autonomy: full_manual default, upgrade to full_auto requires confirmed:true flag (data-layer enforcement)"
  - "Integration tests use unique temp bbolt database paths via PINCH_RELAY_DB env var to avoid file lock conflicts"

requirements-completed: [AUTO-01, AUTO-02, CONN-01, CONN-02]

# Metrics
duration: 8min
completed: 2026-02-27
---

# Phase 2 Plan 3: TypeScript Auth Handshake and Connection Store Summary

**Ed25519 challenge signing with RelayClient auth handshake replacing ?address= param, plus JSON-backed ConnectionStore with full_manual/full_auto autonomy and confirmation gate**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-27T02:21:28Z
- **Completed:** 2026-02-27T02:30:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Created auth module (signChallenge) using libsodium crypto_sign_detached for Ed25519 nonce signing
- Rewrote RelayClient to take Keypair instead of address string, performing full protobuf-based auth handshake on connect (AuthChallenge -> AuthResponse -> AuthResult)
- Eliminated ?address= query parameter -- relay now derives address from authenticated public key
- Built ConnectionStore with JSON persistence supporting all 5 connection states (active, pending_outbound, pending_inbound, blocked, revoked)
- Implemented autonomy levels with data-layer gate: full_manual -> full_auto upgrade requires confirmed:true
- 47 total tests pass across 6 test files (4 auth, 6 relay-client integration, 23 connection store, 14 existing)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement TypeScript auth module and rewrite RelayClient connect with auth handshake** - `10ff1de` (feat)
2. **Task 2: Implement JSON-backed connection store with autonomy levels** - `f64a528` (feat)

Additional commits:
- `b47402b` (fix) - Isolate relay integration tests with temp bbolt database

## Files Created/Modified
- `skill/src/auth.ts` - Ed25519 challenge signing via libsodium crypto_sign_detached
- `skill/src/auth.test.ts` - 4 tests: signature length, verification, nonce uniqueness, wrong key rejection
- `skill/src/relay-client.ts` - Rewritten: Keypair constructor, auth handshake state machine, assignedAddress property
- `skill/src/relay-client.test.ts` - 6 integration tests: auth+connect, multi-client, heartbeat, address stability, non-WS rejection
- `skill/src/connection-store.ts` - JSON-backed store: CRUD, state transitions, autonomy levels, TTL expiration, nickname support
- `skill/src/connection-store.test.ts` - 23 tests: load/save roundtrip, all CRUD ops, autonomy gates, expiration, state transitions

## Decisions Made
- **signChallenge is async**: Calls ensureSodiumReady() internally so callers don't need to manage sodium initialization separately
- **Auth state machine in connect()**: Uses three states (awaiting_challenge, awaiting_result, done) to process the two sequential auth messages before passing subsequent messages to the user's message handler
- **Blocking is reversible**: blocked -> active state transition is supported per the discretion decision in research -- unblocking restores the connection without requiring a new connection request
- **Connection sort order**: active > pending_inbound > pending_outbound > revoked > blocked, then most recent lastActivity first within each group

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Committed uncommitted Go changes from Plan 02-02**
- **Found during:** Task 1 (relay-client integration tests)
- **Issue:** Plan 02-02 left Go hub and main.go changes uncommitted (NewHub now requires *store.BlockStore, RouteMessage added). Go relay wouldn't compile, blocking integration tests.
- **Fix:** Committed the uncommitted 02-02 Go changes as `0b9f05d`
- **Files modified:** relay/cmd/pinchd/main.go, relay/internal/hub/hub.go, relay/internal/hub/hub_test.go, relay/internal/hub/client.go
- **Verification:** `go build ./relay/cmd/pinchd/` succeeds, integration tests pass
- **Committed in:** `0b9f05d`

**2. [Rule 1 - Bug] Fixed bbolt database file lock causing relay startup failure**
- **Found during:** Task 2 verification (re-running all tests)
- **Issue:** Integration tests used relative path for bbolt database (`./pinch-relay.db`), causing file lock conflicts between sequential test runs. Relay would hang on startup.
- **Fix:** Added `PINCH_RELAY_DB` env var with unique temp directory path per test run. Cleanup in afterAll.
- **Files modified:** skill/src/relay-client.test.ts
- **Verification:** Tests pass reliably on consecutive runs
- **Committed in:** `b47402b`

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for test reliability. No scope creep.

## Issues Encountered
- Pre-existing `@types/libsodium-wrappers-sumo` missing declaration file causes `tsc --noEmit` errors -- same issue noted in 02-01-SUMMARY.md, not related to this plan's changes

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Auth module and RelayClient auth handshake are complete -- agents can now authenticate cryptographically to the relay
- ConnectionStore provides the data foundation for connection request/response/revoke operations (Plan 02-04)
- Autonomy confirmation gate is in place at the data layer -- Phase 3 will wire up the UX
- All 47 tests pass reliably with proper test isolation

## Self-Check: PASSED

All key files verified present:
- skill/src/auth.ts: FOUND
- skill/src/auth.test.ts: FOUND
- skill/src/connection-store.ts: FOUND
- skill/src/connection-store.test.ts: FOUND
- skill/src/relay-client.ts: FOUND
- skill/src/relay-client.test.ts: FOUND

All task commits verified in git log: 10ff1de, f64a528, b47402b, 0b9f05d.

---
*Phase: 02-authentication-and-connection*
*Completed: 2026-02-27*
