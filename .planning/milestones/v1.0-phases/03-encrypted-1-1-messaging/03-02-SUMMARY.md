---
phase: 03-encrypted-1-1-messaging
plan: 02
subsystem: messaging
tags: [sqlite, better-sqlite3, ed25519, delivery-confirmation, message-store, nacl]

# Dependency graph
requires:
  - phase: 02-authentication-and-connection
    provides: ConnectionManager, ConnectionStore, RelayClient, identity keypairs
provides:
  - SQLite-backed MessageStore with CRUD, pagination, and atomic sequence numbers
  - Delivery confirmation signing (signDeliveryConfirmation) and verification (verifyDeliveryConfirmation)
  - Real Ed25519 public key exchange in ConnectionManager request/approve
  - getPeerPublicKey fallback method on ConnectionStore
affects: [03-encrypted-1-1-messaging, 04-offline-store-and-forward]

# Tech tracking
tech-stack:
  added: [better-sqlite3, uuid, @types/better-sqlite3]
  patterns: [SQLite WAL mode for concurrent reads, atomic sequence increment via SQL transaction, Ed25519 detached signatures for delivery receipts]

key-files:
  created:
    - skill/src/message-store.ts
    - skill/src/message-store.test.ts
    - skill/src/delivery.ts
    - skill/src/delivery.test.ts
  modified:
    - skill/src/connection.ts
    - skill/src/connection.test.ts
    - skill/src/connection-store.ts
    - skill/package.json
    - pnpm-lock.yaml

key-decisions:
  - "better-sqlite3 native binding via prebuild-install (prebuilt binary) rather than compiling from source"
  - "ConnectionManager.keypair is optional (backward-compatible) -- falls back to empty Uint8Array if not provided"
  - "nextSequence uses INSERT OR IGNORE + UPDATE RETURNING in a transaction for atomic increment"
  - "getPeerPublicKey falls back to extracting key from pinch address when stored key is empty"

patterns-established:
  - "SQLite WAL mode + foreign keys enabled on every MessageStore instance"
  - "Atomic sequence counters via SQL transactions (not in-memory counters)"
  - "Ed25519 detached signatures for delivery confirmation over (messageId || bigint-timestamp)"

requirements-completed: [CRYP-01, CRYP-05]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 3 Plan 2: Message Store, Delivery Signing, and Pubkey Exchange Summary

**SQLite message store with atomic sequence numbers, Ed25519 delivery confirmation signing/verification, and real public key exchange in connection flow**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-27T03:45:23Z
- **Completed:** 2026-02-27T03:51:16Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- MessageStore class persists messages in SQLite with WAL mode, 4 indexes, and paginated history queries
- Per-connection sequence numbers are atomically incremented via SQL transactions (survives restarts)
- Delivery confirmation signing and verification using Ed25519 detached signatures (crypto_sign_detached)
- ConnectionManager now sends real Ed25519 public keys during connection request/approve (was sending empty bytes)
- ConnectionStore.getPeerPublicKey provides fallback extraction from pinch address when stored key is empty

## Task Commits

Each task was committed atomically:

1. **Task 1: Install dependencies, build SQLite message store, and fix pubkey exchange** - `5589a57` (feat)
2. **Task 2: Create delivery confirmation signing and verification module** - `9c5633c` (feat)

## Files Created/Modified

- `skill/src/message-store.ts` - SQLite-backed message persistence with CRUD, pagination, and atomic sequence increment
- `skill/src/message-store.test.ts` - 13 tests covering save/get roundtrip, state updates, history pagination, filtering, pending queries, sequence atomicity
- `skill/src/delivery.ts` - signDeliveryConfirmation and verifyDeliveryConfirmation using Ed25519 detached signatures
- `skill/src/delivery.test.ts` - 6 tests covering sign, verify, wrong key, tampered ID, tampered timestamp, round-trip
- `skill/src/connection.ts` - Added keypair parameter, sends real public keys in request/approve
- `skill/src/connection.test.ts` - Updated all ConnectionManager instantiations to pass test keypair
- `skill/src/connection-store.ts` - Added getPeerPublicKey method with address fallback
- `skill/package.json` - Added better-sqlite3, uuid, @types/better-sqlite3
- `pnpm-lock.yaml` - Updated lockfile

## Decisions Made

- **better-sqlite3 via prebuild-install:** The system Python was missing distutils for node-gyp compilation, so prebuild-install downloaded the prebuilt native binary instead.
- **Optional keypair on ConnectionManager:** Made the keypair parameter optional with `?` to maintain backward compatibility -- existing code without a keypair still works (falls back to empty Uint8Array).
- **Atomic sequence via SQL transaction:** Used `INSERT OR IGNORE` + `UPDATE RETURNING` in a `db.transaction()` to guarantee monotonic, gap-free sequence numbers even across process restarts.
- **getPeerPublicKey address fallback:** Since pinch addresses embed the Ed25519 public key in their base58 payload, we can always extract it as a fallback when the stored peerPublicKey is empty.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] better-sqlite3 native build failed, used prebuild-install**
- **Found during:** Task 1 (dependency installation)
- **Issue:** pnpm's build script approval mechanism was not triggering the native build, and node-gyp failed due to missing Python distutils module
- **Fix:** Ran `npx prebuild-install` directly in the better-sqlite3 package directory to download the prebuilt binary
- **Files modified:** node_modules (not committed)
- **Verification:** `node -e "require('better-sqlite3')"` succeeds, all MessageStore tests pass
- **Committed in:** 5589a57 (part of Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minor build tooling issue resolved. No scope creep.

## Issues Encountered

None beyond the better-sqlite3 build issue documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- MessageStore is ready for use by MessageManager (Plan 3) for outbound/inbound message persistence
- Delivery signing functions are ready for automatic delivery confirmation in the message receive flow
- Real public key exchange means the MessageManager can derive X25519 encryption keys from stored Ed25519 keys
- All 90 tests pass across 10 test files

## Self-Check: PASSED

All 7 key files verified present. Both task commits (5589a57, 9c5633c) verified in git log. 90/90 tests passing.

---
*Phase: 03-encrypted-1-1-messaging*
*Completed: 2026-02-27*
