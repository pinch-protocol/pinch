---
phase: 01-foundation-and-crypto-primitives
plan: 03
subsystem: infra
tags: [websocket, relay, hub, heartbeat, go, chi, typescript, ws]

# Dependency graph
requires:
  - phase: 01-foundation-and-crypto-primitives
    provides: "Monorepo scaffold with Go relay module, TypeScript skill workspace, protobuf schema"
provides:
  - "Go relay WebSocket server with hub-and-spoke connection management"
  - "Routing table mapping pinch: addresses to active WebSocket connections"
  - "Heartbeat ping/pong at 25s interval with 7s pong timeout"
  - "Health endpoint reporting goroutine and connection counts"
  - "TypeScript RelayClient with WebSocket connection and heartbeat"
  - "Cross-language WebSocket integration tests (TS client -> Go relay)"
affects: [02-01, 02-02, 03-01]

# Tech tracking
tech-stack:
  added: ["coder/websocket v1.8.14", "go-chi/chi v5.2.3", "ws 8.x"]
  patterns: ["hub-and-spoke WebSocket architecture with context-based lifecycle", "per-client readPump/writePump/heartbeatLoop goroutines", "integration tests spawn Go relay as child process"]

key-files:
  created:
    - relay/internal/hub/hub.go
    - relay/internal/hub/client.go
    - relay/internal/hub/hub_test.go
    - skill/src/relay-client.ts
    - skill/src/relay-client.test.ts
  modified:
    - relay/cmd/pinchd/main.go
    - relay/go.mod
    - relay/go.sum
    - skill/package.json
    - pnpm-lock.yaml

key-decisions:
  - "Used server context (not HTTP request context) for client lifecycle to prevent premature cancellation after WebSocket upgrade"
  - "InsecureSkipVerify on WebSocket accept for development (cross-origin allowed)"
  - "Integration tests spawn real Go relay as child process rather than mock WS server for true WebSocket interop validation"

patterns-established:
  - "Hub goroutine serializes routing table access via register/unregister channels with RWMutex for external reads"
  - "Client context cancellation cascades to all goroutines (readPump, writePump, heartbeatLoop)"
  - "TypeScript integration tests use PROJECT_ROOT to spawn Go relay from correct working directory"

requirements-completed: [RELY-01, RELY-03, RELY-08]

# Metrics
duration: 6min
completed: 2026-02-26
---

# Phase 1 Plan 3: WebSocket Relay Hub with Heartbeat and TypeScript Client Summary

**Go relay WebSocket hub with address routing table, 25s heartbeat, context-based goroutine lifecycle, and TypeScript client with cross-language integration tests**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-27T01:14:17Z
- **Completed:** 2026-02-27T01:20:27Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Go relay with hub-and-spoke WebSocket architecture: Hub goroutine manages routing table, per-client readPump/writePump/heartbeatLoop goroutines with context-based lifecycle
- Routing table maps pinch: addresses to active WebSocket connections via register/unregister channels
- Heartbeat: 25s ping interval with 7s pong timeout using coder/websocket's Ping method; connection closed with StatusPolicyViolation on timeout
- Health endpoint at /health returns JSON with goroutine count and connection count
- TypeScript RelayClient with connect/disconnect, configurable heartbeat interval, and message handler
- 6 Go tests (register/unregister, lookup, goroutine leak detection, graceful shutdown, health endpoint, concurrent operations) all passing with -race
- 6 TypeScript integration tests spawning real Go relay as child process for cross-language WebSocket validation

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement Go relay hub with WebSocket, heartbeat, and routing table** - `1a38d8f` (feat)
2. **Task 2: Implement TypeScript relay client with heartbeat and integration tests** - `2ca1743` (feat)

## Files Created/Modified
- `relay/internal/hub/hub.go` - Hub struct with routing table, register/unregister channels, Run event loop
- `relay/internal/hub/client.go` - Client struct with readPump, writePump, heartbeatLoop goroutines
- `relay/internal/hub/hub_test.go` - 6 tests: register/unregister, lookup, goroutine leak, graceful shutdown, health, concurrency
- `relay/cmd/pinchd/main.go` - Relay binary with chi router, WebSocket handler at /ws, health at /health, graceful shutdown
- `relay/go.mod` - Added coder/websocket and go-chi/chi dependencies
- `relay/go.sum` - Dependency checksums
- `skill/src/relay-client.ts` - RelayClient class with WebSocket connection, heartbeat, message handling
- `skill/src/relay-client.test.ts` - 6 integration tests against real Go relay process
- `skill/package.json` - Added ws@8 dependency
- `pnpm-lock.yaml` - Updated lockfile

## Decisions Made
- **Server context for client lifecycle**: Used the server's root context (not the HTTP request context) when creating clients. The HTTP request context is cancelled when the handler returns after WebSocket upgrade, which would immediately kill the client goroutines.
- **InsecureSkipVerify for WebSocket accept**: Enabled in development to allow cross-origin connections. Will be locked down in production.
- **Real Go relay for TypeScript integration tests**: Chose to spawn the actual Go relay as a child process rather than use a mock WebSocket server. This validates true cross-language WebSocket interop including heartbeat behavior.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed client context source from r.Context() to server context**
- **Found during:** Task 1 (hub tests)
- **Issue:** Using `r.Context()` (HTTP request context) for the client lifecycle caused all client goroutines to be cancelled immediately after WebSocket upgrade, because the HTTP handler returns after starting goroutines and the request context is cancelled
- **Fix:** Changed `hub.NewClient(h, conn, address, r.Context())` to `hub.NewClient(h, conn, address, serverCtx)` in both main.go and test helper
- **Files modified:** relay/cmd/pinchd/main.go, relay/internal/hub/hub_test.go
- **Verification:** All 6 hub tests pass with -race flag
- **Committed in:** 1a38d8f (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential fix for correct WebSocket lifecycle management. Without it, all connections would die immediately after upgrade. No scope creep.

## Issues Encountered
- TypeScript tests initially failed because `process.cwd()` in vitest was the `skill/` directory, not the project root, so `go run ./relay/cmd/pinchd/` couldn't find the relay module. Fixed by computing `PROJECT_ROOT` from `import.meta.url` and using it as cwd for the child process.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Relay infrastructure complete and tested: WebSocket connections, routing table, heartbeat, health endpoint
- TypeScript client connects and maintains connection with heartbeat
- Ready for Phase 2: authentication can be layered onto the existing /ws endpoint by replacing the query parameter address with challenge-response auth
- No blockers for subsequent plans

## Self-Check: PASSED

All 6 key files verified present. Both task commits (1a38d8f, 2ca1743) verified in git log.

---
*Phase: 01-foundation-and-crypto-primitives*
*Completed: 2026-02-26*
