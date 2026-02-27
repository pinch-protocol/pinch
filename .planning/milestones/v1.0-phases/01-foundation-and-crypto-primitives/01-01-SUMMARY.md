---
phase: 01-foundation-and-crypto-primitives
plan: 01
subsystem: infra
tags: [protobuf, buf, pnpm-workspace, go-workspace, monorepo, ci]

# Dependency graph
requires:
  - phase: none
    provides: "First plan, no dependencies"
provides:
  - "Monorepo with Go relay module and TypeScript skill workspace"
  - "Protobuf v1 wire format schema (Envelope, EncryptedPayload, PlaintextPayload, Handshake, Heartbeat, MessageType)"
  - "Generated Go and TypeScript protobuf code from shared proto files"
  - "Cross-language serialization round-trip tests"
  - "CI pipeline for Go and TypeScript"
affects: [01-02, 01-03, 02-01, 03-01]

# Tech tracking
tech-stack:
  added: ["buf 1.66.0", "protobuf-es 2.11.0", "protoc-gen-go 1.36.11", "vitest 4.x", "biome", "pnpm workspaces", "go.work"]
  patterns: ["buf generate for cross-language codegen", "pnpm workspace:* for shared TS packages", "go.work for multi-module Go workspace"]

key-files:
  created:
    - proto/pinch/v1/envelope.proto
    - gen/go/pinch/v1/envelope.pb.go
    - gen/ts/pinch/v1/envelope_pb.ts
    - relay/cmd/pinchd/main.go
    - relay/internal/protocol/proto_test.go
    - skill/src/proto.test.ts
    - skill/src/index.ts
    - buf.yaml
    - buf.gen.yaml
    - go.work
    - pnpm-workspace.yaml
    - biome.json
    - .github/workflows/ci.yml
    - .gitignore
  modified: []

key-decisions:
  - "buf.gen.yaml clean:false to preserve go.mod and package.json in gen/ directories"
  - "buf plugin buf.build/bufbuild/es (not protobuf-es) for protobuf-es v2 codegen"
  - "buf.yaml STANDARD lint category (not deprecated DEFAULT)"
  - "@bufbuild/protobuf added as direct skill dependency for test imports"

patterns-established:
  - "Proto schema at proto/pinch/v1/ with buf generate outputting to gen/go/ and gen/ts/"
  - "Go tests run from workspace root via go.work (not from relay/ individually)"
  - "TypeScript imports proto types from @pinch/proto workspace package"

requirements-completed: [PROT-01, PROT-02, PROT-03, PROT-04]

# Metrics
duration: 6min
completed: 2026-02-26
---

# Phase 1 Plan 1: Monorepo Scaffold and Protobuf Schema Summary

**Monorepo with pnpm+go.work wiring, buf protobuf codegen producing Go and TypeScript from shared pinch.v1 schema, and cross-language serialization round-trip tests**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-27T01:04:54Z
- **Completed:** 2026-02-27T01:11:02Z
- **Tasks:** 2
- **Files modified:** 21

## Accomplishments
- Working monorepo: Go relay compiles, TypeScript skill compiles, pnpm workspace resolves @pinch/proto
- Complete v1 proto schema with Envelope (version, from/to address, MessageType, oneof payload), EncryptedPayload (nonce, ciphertext, sender_public_key), PlaintextPayload (version, sequence, timestamp, content, content_type), Handshake (signing_key, encryption_key), Heartbeat
- buf generate produces both Go and TypeScript code from shared proto/pinch/v1/envelope.proto
- Serialization round-trip tests pass in both Go (4 tests) and TypeScript (4 tests) independently
- CI workflow configured for Go build/test/lint and TypeScript lint/test

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold monorepo structure** - `068b308` (feat)
2. **Task 2: Define protobuf schema and generate cross-language code** - `52a120b` (feat)

## Files Created/Modified
- `proto/pinch/v1/envelope.proto` - Complete v1 wire format schema
- `gen/go/pinch/v1/envelope.pb.go` - Generated Go protobuf types
- `gen/ts/pinch/v1/envelope_pb.ts` - Generated TypeScript protobuf types
- `relay/cmd/pinchd/main.go` - Stub relay entry point
- `relay/go.mod` - Go module for relay
- `gen/go/go.mod` - Go module for generated code with protobuf dependency
- `go.work` - Go workspace linking relay and gen/go
- `skill/package.json` - TypeScript skill with @pinch/proto and @bufbuild/protobuf dependencies
- `skill/tsconfig.json` - Strict TypeScript config with NodeNext module resolution
- `gen/ts/package.json` - @pinch/proto package with @bufbuild/protobuf dependency
- `pnpm-workspace.yaml` - Workspace: skill + gen/ts
- `buf.yaml` - buf v2 config with STANDARD lint, FILE breaking
- `buf.gen.yaml` - Code generation: protocolbuffers/go + bufbuild/es plugins
- `biome.json` - Recommended preset with organizeImports
- `.github/workflows/ci.yml` - Go + TypeScript CI matrix
- `.gitignore` - node_modules, dist, .env, coverage
- `relay/internal/protocol/proto_test.go` - Go serialization round-trip tests
- `skill/src/proto.test.ts` - TypeScript serialization round-trip tests
- `skill/src/index.ts` - Stub export

## Decisions Made
- Changed buf.gen.yaml `clean: false` (was `true`) because `clean: true` deletes go.mod and package.json from gen/ output directories, breaking the workspace setup
- Used `buf.build/bufbuild/es` plugin instead of `buf.build/bufbuild/protobuf-es` (the latter was not found; es is the correct name for protobuf-es v2)
- Updated buf.yaml to use `STANDARD` lint category instead of deprecated `DEFAULT`
- Added `@bufbuild/protobuf` as a direct dependency of `@pinch/skill` since TypeScript tests import `create`, `toBinary`, `fromBinary` directly from it

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed Go, pnpm, and buf CLI**
- **Found during:** Task 1 (pre-execution)
- **Issue:** Go, pnpm, and buf CLI were not installed on the system
- **Fix:** `brew install go`, `npm install -g pnpm`, `npm install -g @bufbuild/buf`
- **Files modified:** None (system-level)
- **Verification:** All three tools verified with version checks

**2. [Rule 1 - Bug] Fixed buf plugin name for protobuf-es v2**
- **Found during:** Task 2 (buf generate)
- **Issue:** `buf.build/bufbuild/protobuf-es` plugin not found; renamed to `buf.build/bufbuild/es` in newer buf versions
- **Fix:** Updated buf.gen.yaml to use `buf.build/bufbuild/es`
- **Files modified:** buf.gen.yaml
- **Committed in:** 52a120b (Task 2 commit)

**3. [Rule 1 - Bug] Disabled buf.gen.yaml clean:true**
- **Found during:** Task 2 (buf generate deleted go.mod and package.json)
- **Issue:** `clean: true` deletes all files in output directories including go.mod and package.json that are needed for workspace resolution
- **Fix:** Changed to `clean: false`
- **Files modified:** buf.gen.yaml
- **Committed in:** 52a120b (Task 2 commit)

**4. [Rule 3 - Blocking] Added @bufbuild/protobuf as direct skill dependency**
- **Found during:** Task 2 (TypeScript tests)
- **Issue:** Test imports `create`, `toBinary`, `fromBinary` from `@bufbuild/protobuf` but it was only a transitive dependency through @pinch/proto
- **Fix:** Added `@bufbuild/protobuf: "^2.11.0"` to skill/package.json dependencies
- **Files modified:** skill/package.json, pnpm-lock.yaml
- **Committed in:** 52a120b (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (2 bugs, 2 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and build functionality. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Monorepo scaffold complete with working Go + TypeScript compilation
- Proto schema ready for use by Plan 02 (Ed25519 identity and NaCl crypto) and Plan 03 (WebSocket relay)
- Generated code importable in both languages via workspace wiring
- No blockers for subsequent plans

## Self-Check: PASSED

All 14 key files verified present. Both task commits (068b308, 52a120b) verified in git log.

---
*Phase: 01-foundation-and-crypto-primitives*
*Completed: 2026-02-26*
