---
phase: 01-foundation-and-crypto-primitives
plan: 02
subsystem: crypto
tags: [ed25519, x25519, nacl-box, libsodium, base58, identity, cross-language]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Monorepo scaffold with Go relay module, TypeScript skill workspace, and pnpm wiring"
provides:
  - "Go NaCl box encrypt/decrypt with Ed25519-to-X25519 conversion"
  - "Go address generation and validation (pinch:<base58>@host format)"
  - "TypeScript NaCl box encrypt/decrypt with Ed25519-to-X25519 conversion via libsodium-sumo"
  - "TypeScript keypair generation, persistence, and address derivation"
  - "Shared cross-language test vectors (identity + crypto)"
  - "Live cross-process crypto roundtrip integration tests (Go->TS, TS->Go)"
  - "CI workflow with cross-language crypto job"
affects: [01-03, 02-01, 02-02, 03-01]

# Tech tracking
tech-stack:
  added: ["filippo.io/edwards25519 v1.2.0", "golang.org/x/crypto/nacl/box v0.48.0", "github.com/mr-tron/base58 v1.2.0", "libsodium-wrappers-sumo 0.8.0", "bs58 ^6.0.0"]
  patterns: ["Shared JSON test vectors in testdata/ for cross-language verification", "NaCl box with 24-byte random nonce prepended to ciphertext", "Ed25519-to-X25519 conversion for dual signing/encryption from single keypair", "pinch: address format with 4-byte SHA-256 checksum"]

key-files:
  created:
    - relay/internal/crypto/crypto.go
    - relay/internal/crypto/crypto_test.go
    - relay/internal/identity/identity.go
    - relay/internal/identity/identity_test.go
    - skill/src/crypto.ts
    - skill/src/crypto.test.ts
    - skill/src/identity.ts
    - skill/src/identity.test.ts
    - testdata/crypto_vectors.json
    - testdata/identity_vectors.json
    - tests/cross-language/run.sh
    - tests/cross-language/ts_encrypt/encrypt.ts
    - tests/cross-language/ts_decrypt/decrypt.ts
    - relay/cmd/crosstest-encrypt/main.go
    - relay/cmd/crosstest-decrypt/main.go
  modified:
    - .github/workflows/ci.yml
    - .gitignore
    - skill/package.json
    - pnpm-lock.yaml
    - go.work

key-decisions:
  - "Go cross-language test programs placed in relay/cmd/ to access internal crypto package (Go internal visibility)"
  - "Test vectors generated from Go (golang.org/x/crypto as reference NaCl implementation) and verified in TypeScript"
  - "CI cross-language job depends on both Go and TypeScript jobs passing first"

patterns-established:
  - "Cross-language crypto verification via shared JSON test vectors in testdata/"
  - "Live process-to-process integration tests in tests/cross-language/ with bash orchestration"
  - "Address format: pinch:<base58(pubkey + SHA-256(pubkey)[0:4])>@<host>"
  - "Keypair persistence as JSON with version field, base64-encoded keys"

requirements-completed: [IDNT-01, IDNT-02, IDNT-03, CRYP-02, CRYP-03, CRYP-04]

# Metrics
duration: 10min
completed: 2026-02-27
---

# Phase 1 Plan 2: Ed25519 Identity and NaCl Box Crypto Summary

**Cross-language Ed25519 identity with pinch: addressing and NaCl box encryption -- Go and TypeScript produce identical keys, addresses, and interoperable ciphertexts verified via shared test vectors and live process roundtrips**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-27T01:14:02Z
- **Completed:** 2026-02-27T01:24:15Z
- **Tasks:** 2
- **Files modified:** 20

## Accomplishments
- Go and TypeScript both convert Ed25519 keys to X25519, producing identical results from same seeds
- NaCl box encrypt/decrypt works in both languages with random 24-byte nonces prepended to ciphertext
- Address generation produces identical `pinch:<base58(pubkey+checksum)>@<host>` addresses from same public keys in both languages
- TypeScript keypair generates, persists to disk as JSON, and reloads with same derived address
- Live cross-process integration: Go encrypts -> TS decrypts and TS encrypts -> Go decrypts for 3 test cases (6 roundtrips total)
- CI workflow updated with cross-language crypto job

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement identity and crypto modules with shared test vectors (TDD)** - `6ad851f` (feat)
2. **Task 2: Cross-language live crypto roundtrip integration tests** - `5aad1ef` (feat)

## Files Created/Modified
- `relay/internal/crypto/crypto.go` - Go NaCl box encrypt/decrypt + Ed25519-to-X25519 conversion
- `relay/internal/crypto/crypto_test.go` - Go crypto tests against shared vectors
- `relay/internal/identity/identity.go` - Go address generation, validation, and parsing
- `relay/internal/identity/identity_test.go` - Go identity tests against shared vectors
- `skill/src/crypto.ts` - TypeScript NaCl box encrypt/decrypt + Ed25519-to-X25519 via libsodium-sumo
- `skill/src/crypto.test.ts` - TypeScript crypto tests against shared vectors
- `skill/src/identity.ts` - TypeScript keypair generation, persistence, address derivation/validation
- `skill/src/identity.test.ts` - TypeScript identity tests against shared vectors
- `testdata/crypto_vectors.json` - 3 crypto test vectors with deterministic seeds, nonces, ciphertexts
- `testdata/identity_vectors.json` - 3 identity test vectors with Ed25519, X25519, and pinch: addresses
- `tests/cross-language/run.sh` - Bash script orchestrating live Go<->TS crypto roundtrips
- `tests/cross-language/ts_encrypt/encrypt.ts` - TypeScript encrypt CLI for integration tests
- `tests/cross-language/ts_decrypt/decrypt.ts` - TypeScript decrypt CLI for integration tests
- `relay/cmd/crosstest-encrypt/main.go` - Go encrypt CLI for integration tests
- `relay/cmd/crosstest-decrypt/main.go` - Go decrypt CLI for integration tests
- `.github/workflows/ci.yml` - Added cross-language job, bumped Go to 1.24
- `.gitignore` - Added /pinchd binary and .build/ directory

## Decisions Made
- Placed Go cross-language test programs in `relay/cmd/` rather than `tests/cross-language/` because Go's `internal` package visibility rules prevent external modules from importing `relay/internal/crypto`. The test programs need access to the crypto package.
- Generated test vectors from Go (using `golang.org/x/crypto` as the reference NaCl implementation) then verified in TypeScript. This ensures the Go implementation is the source of truth.
- CI cross-language job depends on both Go and TypeScript jobs passing first, ensuring individual language tests pass before testing interoperability.
- Go version bumped to 1.24 in CI to match the go.work minimum (required by dependency chain from filippo.io/edwards25519).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Go internal package visibility for cross-language tests**
- **Found during:** Task 2 (building Go encrypt/decrypt programs)
- **Issue:** Plan specified Go programs in `tests/cross-language/go_encrypt/` and `tests/cross-language/go_decrypt/` with their own go.mod. Go's `internal` package rules prevent importing `relay/internal/crypto` from a separate module.
- **Fix:** Moved Go programs to `relay/cmd/crosstest-encrypt/` and `relay/cmd/crosstest-decrypt/` within the relay module, updated run.sh to build from workspace root.
- **Files modified:** tests/cross-language/run.sh, relay/cmd/crosstest-encrypt/main.go, relay/cmd/crosstest-decrypt/main.go
- **Verification:** `go build ./relay/cmd/crosstest-encrypt` succeeds, integration tests pass
- **Committed in:** 5aad1ef (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary restructuring due to Go language constraint. No scope creep, same functionality delivered.

## Issues Encountered
None beyond the deviation documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Crypto primitives complete and verified cross-language, ready for Phase 2 (authentication handshake)
- Identity module provides address generation needed for connection management
- Encrypt/decrypt functions ready for message payload encryption in Phase 3
- No blockers for subsequent plans

## Self-Check: PASSED

All 16 key files verified present. Both task commits (6ad851f, 5aad1ef) verified in git log.

---
*Phase: 01-foundation-and-crypto-primitives*
*Completed: 2026-02-27*
