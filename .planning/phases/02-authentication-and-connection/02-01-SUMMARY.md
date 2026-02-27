---
phase: 02-authentication-and-connection
plan: 01
subsystem: auth
tags: [ed25519, challenge-response, protobuf, websocket, relay, auth]

# Dependency graph
requires:
  - phase: 01-foundation-and-crypto-primitives
    provides: "Monorepo with Go relay hub, Ed25519 identity package, protobuf schema, TypeScript skill"
provides:
  - "Extended protobuf schema with 8 new message types (auth, connection, block lifecycle)"
  - "Relay auth module with GenerateChallenge, VerifyChallenge, DeriveAddress"
  - "Post-upgrade Ed25519 challenge-response handshake replacing ?address= query parameter"
  - "10-second auth timeout preventing resource exhaustion"
  - "Client struct with authenticated PublicKey field"
affects: [02-02, 02-03, 02-04, 03-01]

# Tech tracking
tech-stack:
  added: []
  patterns: ["post-upgrade challenge-response auth via protobuf Envelope over WebSocket", "auth module delegates to identity package for address derivation", "performAuth separates auth logic from wsHandler for testability"]

key-files:
  created:
    - relay/internal/auth/auth.go
    - relay/internal/auth/auth_test.go
  modified:
    - proto/pinch/v1/envelope.proto
    - gen/go/pinch/v1/envelope.pb.go
    - gen/ts/pinch/v1/envelope_pb.ts
    - relay/internal/hub/client.go
    - relay/internal/hub/hub_test.go
    - relay/cmd/pinchd/main.go

key-decisions:
  - "Auth module delegates to identity.GenerateAddress for address derivation rather than reimplementing the algorithm"
  - "performAuth extracted as separate function from wsHandler for clear separation and testability"
  - "WebSocket close code 4001 used for auth failures (custom application code per WebSocket spec)"

patterns-established:
  - "Auth handshake uses protobuf Envelope with AuthChallenge/AuthResponse/AuthResult payloads over binary WebSocket"
  - "Client registration happens ONLY after auth succeeds (hub.Register called post-auth, not pre-auth)"
  - "PINCH_RELAY_HOST env var controls the relay host in derived addresses (default: localhost)"

requirements-completed: [RELY-02]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 2 Plan 1: Protobuf Auth Schema and Ed25519 Challenge-Response Authentication Summary

**Extended protobuf schema with 8 Phase 2 message types and replaced insecure ?address= query parameter with post-upgrade Ed25519 challenge-response handshake on the relay**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-27T02:13:19Z
- **Completed:** 2026-02-27T02:18:08Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Extended protobuf schema with AuthChallenge, AuthResponse, AuthResult, ConnectionRequest, ConnectionResponse, ConnectionRevoke, BlockNotification, UnblockNotification messages and 4 new MessageType enum values
- Created relay auth module with GenerateChallenge (32-byte crypto/rand nonce), VerifyChallenge (Ed25519 signature check with length validation), and DeriveAddress (delegates to identity package)
- Rewrote wsHandler to perform post-upgrade challenge-response: send AuthChallenge, read AuthResponse, verify signature, derive address, send AuthResult, then register in hub
- 10-second auth timeout via context.WithTimeout prevents resource exhaustion from connections that never complete auth
- Client struct now stores authenticated Ed25519 PublicKey alongside derived address
- 9 auth unit tests pass with -race flag covering nonce generation, signature verification (valid/invalid/wrong nonce), key/signature size validation, and address derivation consistency

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend protobuf schema with Phase 2 message types and regenerate** - `7463108` (feat)
2. **Task 2: Implement relay auth module and rewrite wsHandler with challenge-response** - `5e547c4` (feat)

## Files Created/Modified
- `proto/pinch/v1/envelope.proto` - Added 8 new message types, 4 enum values, 8 oneof payload variants
- `gen/go/pinch/v1/envelope.pb.go` - Regenerated Go protobuf types with all new messages
- `gen/ts/pinch/v1/envelope_pb.ts` - Regenerated TypeScript protobuf types with all new messages
- `relay/internal/auth/auth.go` - Auth module: GenerateChallenge, VerifyChallenge, DeriveAddress
- `relay/internal/auth/auth_test.go` - 9 tests covering all auth functions
- `relay/internal/hub/client.go` - Added PublicKey field to Client, updated NewClient signature
- `relay/internal/hub/hub_test.go` - Updated NewClient call to match new signature (nil pubKey for hub-only tests)
- `relay/cmd/pinchd/main.go` - Rewritten wsHandler with challenge-response, added performAuth and sendAuthFailure helpers, PINCH_RELAY_HOST env var

## Decisions Made
- **Auth module delegates to identity package:** Rather than reimplementing the address derivation algorithm, `DeriveAddress` calls `identity.GenerateAddress` directly. This ensures the auth-derived address always matches the identity package format.
- **performAuth as separate function:** Extracted the auth handshake into `performAuth()` separate from the HTTP handler closure. This provides clean separation of concerns and will make integration testing straightforward.
- **Close code 4001 for auth failures:** Used custom WebSocket application close code 4001 (in the 4000-4999 range reserved for applications) to signal auth failure to clients, following the WebSocket specification.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing TypeScript compilation error (`@types/libsodium-wrappers-sumo` missing) causes `tsc --noEmit` to fail, but this is unrelated to the proto changes (zero errors in generated `envelope_pb.ts`). Logged as out-of-scope pre-existing issue.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Protobuf schema has all Phase 2 message types ready for connection lifecycle plans
- Relay auth module is complete and tested; TypeScript agent-side auth signing needs to be implemented in a subsequent plan (02-02) to update RelayClient with challenge-response support
- Hub now requires authenticated clients, closing the impersonation attack vector from Phase 1
- No blockers for subsequent plans

## Self-Check: PASSED

All key files verified present:
- relay/internal/auth/auth.go: FOUND
- relay/internal/auth/auth_test.go: FOUND
- proto/pinch/v1/envelope.proto: FOUND
- gen/go/pinch/v1/envelope.pb.go: FOUND
- gen/ts/pinch/v1/envelope_pb.ts: FOUND
- relay/internal/hub/client.go: FOUND
- relay/cmd/pinchd/main.go: FOUND

Both task commits verified in git log: 7463108, 5e547c4.

---
*Phase: 02-authentication-and-connection*
*Completed: 2026-02-27*
