---
phase: 06-oversight-and-safety
plan: 02
subsystem: relay
tags: [rate-limiting, token-bucket, protobuf, golang, websocket]

# Dependency graph
requires:
  - phase: 02-message-routing
    provides: Hub routing and Client lifecycle
  - phase: 04-store-and-forward
    provides: Message queue and QueueFull pattern
provides:
  - Per-connection token bucket rate limiter (ratelimit.go)
  - RateLimited protobuf message type with retry-after
  - Configurable rate/burst via env vars
  - TypeScript RateLimited handler
affects: [06-oversight-and-safety]

# Tech tracking
tech-stack:
  added: [golang.org/x/time/rate]
  patterns: [token-bucket rate limiting, per-connection limiter with lazy creation, limiter cleanup on disconnect]

key-files:
  created:
    - relay/internal/hub/ratelimit.go
    - relay/internal/hub/ratelimit_test.go
  modified:
    - proto/pinch/v1/envelope.proto
    - gen/go/pinch/v1/envelope.pb.go
    - gen/ts/pinch/v1/envelope_pb.ts
    - relay/internal/hub/hub.go
    - relay/cmd/pinchd/main.go
    - skill/src/message-manager.ts

key-decisions:
  - "Token bucket via golang.org/x/time/rate: stdlib-quality, well-tested, minimal dependency"
  - "Rate limit check BEFORE envelope size check: reject fast before deserializing"
  - "Lazy limiter creation: no upfront allocation, memory proportional to active clients"
  - "TypeScript handler logs only: rate limits should only fire during abuse, no backoff needed in v1"

patterns-established:
  - "Rate limit check pattern: nil-safe check first in RouteMessage, send typed error envelope"
  - "Limiter cleanup pattern: Remove in unregister case to prevent memory leaks"

requirements-completed: [RELY-07]

# Metrics
duration: 4min
completed: 2026-02-27
---

# Phase 06 Plan 02: Rate Limiting Summary

**Per-connection token bucket rate limiter using golang.org/x/time/rate with RateLimited proto error message and TypeScript handling**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-27T07:53:21Z
- **Completed:** 2026-02-27T07:57:19Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Per-connection token bucket rate limiter enforces 1 msg/s sustained with burst of 10
- RateLimited protobuf message sends actionable retry-after feedback (not silent drops)
- Limiter entries cleaned up on disconnect -- no memory leak for transient connections
- Configurable via PINCH_RELAY_RATE_LIMIT and PINCH_RELAY_RATE_BURST env vars
- TypeScript MessageManager gracefully handles RateLimited envelopes

## Task Commits

Each task was committed atomically:

1. **Task 1: Proto schema extension and Go rate limiter with hub integration** - `4a119b0` (feat)
2. **Task 2: TypeScript handling of RateLimited message type** - `fa9c0bc` (feat)

## Files Created/Modified
- `proto/pinch/v1/envelope.proto` - Added MESSAGE_TYPE_RATE_LIMITED enum and RateLimited message
- `gen/go/pinch/v1/envelope.pb.go` - Regenerated Go protobuf code
- `gen/ts/pinch/v1/envelope_pb.ts` - Regenerated TypeScript protobuf code
- `relay/internal/hub/ratelimit.go` - Per-connection token bucket rate limiter
- `relay/internal/hub/ratelimit_test.go` - Rate limiter tests (allow, burst exhaust, remove, concurrency)
- `relay/internal/hub/hub.go` - Integrated rate limiter into RouteMessage and unregister cleanup
- `relay/internal/hub/hub_test.go` - Updated all NewHub calls with nil rate limiter param
- `relay/cmd/pinchd/main.go` - Added rate limit env var parsing and limiter creation
- `relay/go.mod` - Added golang.org/x/time dependency
- `skill/src/message-manager.ts` - Added RateLimited handler with retry-after logging

## Decisions Made
- Used golang.org/x/time/rate for token bucket implementation (stdlib-quality, well-tested)
- Rate limit check placed BEFORE envelope size check for fastest rejection path
- Lazy limiter creation per address (no upfront allocation, memory proportional to active clients)
- TypeScript handler logs only (no automatic backoff in v1 -- rate limits are for obvious abuse)
- Default: 1 msg/s sustained with burst of 10 (generous enough for normal chatty agents)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Rate limiting infrastructure in place for relay protection
- RateLimited message type available for future client-side backoff strategies
- Env vars documented for production tuning

## Self-Check: PASSED

- All created files verified present on disk
- Both task commits (4a119b0, fa9c0bc) verified in git history

---
*Phase: 06-oversight-and-safety*
*Completed: 2026-02-27*
