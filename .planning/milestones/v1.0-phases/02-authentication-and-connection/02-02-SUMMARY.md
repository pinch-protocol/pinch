---
phase: 02-authentication-and-connection
plan: 02
subsystem: relay
tags: [bbolt, block-list, message-routing, websocket, hub, relay]

# Dependency graph
requires:
  - phase: 02-authentication-and-connection
    plan: 01
    provides: "Protobuf schema with BlockNotification/UnblockNotification message types, authenticated WebSocket clients in hub"
provides:
  - "bbolt-backed persistent block store with directional Block/Unblock/IsBlocked"
  - "Hub message routing with block enforcement (silent drop for blocked senders)"
  - "BlockNotification and UnblockNotification handled as relay-side commands"
  - "Client.Send with non-blocking channel write for message delivery"
affects: [02-03, 02-04, 04-01]

# Tech tracking
tech-stack:
  added: ["go.etcd.io/bbolt v1.4.3"]
  patterns: ["bbolt bucket-per-concern (blocks bucket)", "directional key format blockerAddr:blockedAddr", "silent drop pattern for blocked and offline recipients"]

key-files:
  created:
    - relay/internal/store/blockstore.go
    - relay/internal/store/blockstore_test.go
  modified:
    - relay/internal/hub/hub.go
    - relay/internal/hub/client.go
    - relay/internal/hub/hub_test.go
    - relay/cmd/pinchd/main.go
    - relay/go.mod
    - relay/go.sum

key-decisions:
  - "BlockStore uses blocker:blocked key format for O(1) lookups via bbolt read-only transactions"
  - "RouteMessage uses authenticated sender address (not payload field) for block/unblock commands to prevent spoofing"
  - "Client.Send uses non-blocking select with default to drop messages when send buffer is full"

patterns-established:
  - "Block enforcement happens BEFORE recipient lookup in routing (check blockStore.IsBlocked first)"
  - "Silent drop for both blocked and offline recipients -- sender cannot distinguish between them"
  - "BlockNotification/UnblockNotification are relay-side commands, not routed to recipients"
  - "PINCH_RELAY_DB env var controls bbolt database path (default: ./pinch-relay.db)"

requirements-completed: [CONN-04]

# Metrics
duration: 4min
completed: 2026-02-27
---

# Phase 2 Plan 2: Block Store and Hub Message Routing Summary

**bbolt-backed block list with directional semantics and hub message routing with silent-drop block enforcement**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-27T02:21:23Z
- **Completed:** 2026-02-27T02:25:30Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Created bbolt-backed BlockStore with Block/Unblock/IsBlocked supporting directional semantics and persistence across relay restarts
- Implemented Hub.RouteMessage that deserializes protobuf envelopes, handles block/unblock commands, enforces block checks before delivery, and silently drops blocked/offline messages
- Added Client.Send with non-blocking channel write to prevent blocked senders from stalling the relay
- Wired BlockStore into main.go with PINCH_RELAY_DB env var for configurable database path
- 19 tests pass with -race flag (7 store + 12 hub)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement bbolt-backed block store** - `98b390a` (feat)
2. **Task 2: Add message routing to hub with block enforcement** - `0b9f05d` (feat)

## Files Created/Modified
- `relay/internal/store/blockstore.go` - bbolt-backed BlockStore with Block/Unblock/IsBlocked/Close
- `relay/internal/store/blockstore_test.go` - 7 tests covering directional blocking, persistence, unblock, multiple blocks
- `relay/internal/hub/hub.go` - Added blockStore field, NewHub accepts *BlockStore, RouteMessage method
- `relay/internal/hub/client.go` - Added Send method with non-blocking channel write, ReadPump routes messages
- `relay/internal/hub/hub_test.go` - 6 new routing tests: delivery, offline drop, blocked drop, block/unblock notifications, no error indication
- `relay/cmd/pinchd/main.go` - Opens bbolt BlockStore at startup, passes to NewHub, deferred Close
- `relay/go.mod` - Added go.etcd.io/bbolt dependency
- `relay/go.sum` - Updated checksums

## Decisions Made
- **Key format blockerAddr:blockedAddr:** Simple concatenation with colon separator provides O(1) lookups in bbolt. No need for a secondary index since all queries are by exact blocker+blocked pair.
- **Authenticated sender for block commands:** RouteMessage uses `from.Address()` (verified during auth handshake) rather than the `blocker_address` field in the BlockNotification payload. This prevents a client from issuing blocks on behalf of another address.
- **Non-blocking Send:** Client.Send uses select with default case to drop messages when the send buffer is full rather than blocking the caller. This prevents a slow client from stalling message routing for other clients.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required. The PINCH_RELAY_DB env var defaults to `./pinch-relay.db` for development.

## Next Phase Readiness
- Block store and message routing are complete; relay can now route messages between authenticated clients with block enforcement
- Connection request/response routing will use the same RouteMessage path (plans 02-03, 02-04)
- bbolt dependency is now available for Phase 4 store-and-forward without adding a new dependency

## Self-Check: PASSED

All key files verified present:
- relay/internal/store/blockstore.go: FOUND
- relay/internal/store/blockstore_test.go: FOUND
- relay/internal/hub/hub.go: FOUND
- relay/internal/hub/client.go: FOUND
- relay/internal/hub/hub_test.go: FOUND
- relay/cmd/pinchd/main.go: FOUND

Both task commits verified in git log: 98b390a, 0b9f05d.

---
*Phase: 02-authentication-and-connection*
*Completed: 2026-02-27*
