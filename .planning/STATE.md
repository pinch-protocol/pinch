# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-26)

**Core value:** Agents can securely message each other with human consent and oversight at every step -- no message flows without explicit human approval of the connection.
**Current focus:** Phase 6 in progress. Oversight and safety -- unified event log, human intervention, audit, rate limiting, muting.

## Current Position

Phase: 6 of 6 (Oversight and Safety)
Plan: 4 of 4 in current phase (complete)
Status: Executing
Last activity: 2026-02-27 -- Completed 06-04-PLAN.md

Progress: [████████████████████████] 95%

## Performance Metrics

**Velocity:**
- Total plans completed: 19
- Average duration: 6min
- Total execution time: 2.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | 18min | 6min |
| 02 | 4 | 24min | 6min |
| 03 | 4 | 23min | 6min |
| 04 | 2 | 15min | 8min |
| 05 | 3 | 15min | 5min |
| 06 | 3 | 11min | 4min |

**Recent Trend:**
- Last 5 plans: 05-03 (5min), 06-01 (4min), 06-02 (4min), 06-04 (3min)
- Trend: stable

*Updated after each plan completion*
| Phase 02 P01 | 5min | 2 tasks | 8 files |
| Phase 02 P02 | 4min | 2 tasks | 8 files |
| Phase 02 P03 | 8min | 2 tasks | 6 files |
| Phase 02 P04 | 7min | 2 tasks | 6 files |
| Phase 03 P01 | 9min | 2 tasks | 6 files |
| Phase 03 P02 | 5min | 2 tasks | 9 files |
| Phase 03 P03 | 5min | 2 tasks | 6 files |
| Phase 03 P04 | 4min | 2 tasks | 13 files |
| Phase 04 P01 | 5min | 2 tasks | 10 files |
| Phase 04 P02 | 10min | 2 tasks | 7 files |
| Phase 05 P01 | 6min | 2 tasks | 12 files |
| Phase 05 P02 | 4min | 2 tasks | 11 files |
| Phase 05 P03 | 5min | 2 tasks | 11 files |
| Phase 06 P01 | 4min | 2 tasks | 5 files |
| Phase 06 P02 | 4min | 2 tasks | 10 files |
| Phase 06 P04 | 3min | 2 tasks | 6 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Group channels deferred to v2 -- get 1:1 solid first, complexity cost is high
- [Roadmap]: Phases 4 and 5 can execute in parallel (both depend only on Phase 3), but Phase 4 prioritized because agents are intermittently offline during dev testing
- [01-01]: buf.gen.yaml clean:false to preserve go.mod and package.json in gen/ directories
- [01-01]: buf plugin buf.build/bufbuild/es (not protobuf-es) for protobuf-es v2 codegen
- [01-01]: @bufbuild/protobuf added as direct skill dependency for test imports
- [01-02]: Go cross-language test programs in relay/cmd/ (not tests/) due to Go internal package visibility
- [01-02]: Test vectors generated from Go (golang.org/x/crypto as reference NaCl implementation)
- [01-02]: Go version bumped to 1.24 in CI to match go.work minimum
- [01-03]: Server context (not HTTP request context) for WebSocket client lifecycle to prevent premature cancellation
- [01-03]: InsecureSkipVerify on WebSocket accept for development cross-origin support
- [01-03]: Real Go relay integration tests over mock WS server for true cross-language WebSocket validation
- [02-01]: Auth module delegates to identity.GenerateAddress for address derivation (single source of truth)
- [02-01]: performAuth extracted as separate function from wsHandler for testability
- [02-01]: WebSocket close code 4001 for auth failures (custom application code per spec)
- [Phase 02-01]: Auth module delegates to identity.GenerateAddress for address derivation (single source of truth)
- [02-02]: RouteMessage uses authenticated sender address (not payload field) for block/unblock to prevent spoofing
- [02-02]: Client.Send non-blocking with select+default to prevent slow clients stalling routing
- [02-02]: PINCH_RELAY_DB env var for bbolt database path (default: ./pinch-relay.db)
- [02-03]: signChallenge is async (calls ensureSodiumReady internally) -- caller doesn't need to manage sodium init
- [02-03]: RelayClient auth handshake uses state machine (awaiting_challenge -> awaiting_result -> done)
- [02-03]: Connection store sorts by state priority (active > pending_inbound > pending_outbound > revoked > blocked)
- [02-03]: Blocking is reversible -- blocked -> active transition allowed (unblock restores connection)
- [02-04]: sendEnvelope delegates to existing send() -- thin typed wrapper, no new transport layer
- [02-04]: onEnvelope runs alongside onMessage (both fire for post-auth messages) to avoid breaking existing consumers
- [02-04]: Silent rejection sends zero bytes -- rejectRequest only updates local store, indistinguishable from offline
- [02-04]: Integration tests spawn real Go relay via go run for true cross-language validation
- [03-01]: WebSocket read limit set to 2x maxEnvelopeSize (128KB) for application-level silent drop of oversized envelopes
- [03-01]: Pending message cleanup via ticker in Run goroutine select loop (single-writer serialization model)
- [03-01]: PendingCount exported for test observability
- [Phase 03]: better-sqlite3 native binding via prebuild-install for message store
- [Phase 03]: ConnectionManager.keypair optional parameter for backward compatibility
- [Phase 03]: Atomic sequence counters via SQL transactions (INSERT OR IGNORE + UPDATE RETURNING)
- [03-03]: RelayClient.onEnvelope changed from single callback to array for ConnectionManager + MessageManager coexistence
- [03-03]: RelayClient.disconnect() disables autoReconnect to prevent reconnection after intentional disconnect
- [03-03]: InboundRouter defaults unknown autonomy levels to full_manual (escalated_to_human) for safety
- [03-03]: getPendingForReview returns ASC order (oldest first) for HEARTBEAT.md checklist
- [03-04]: Self-executable TypeScript modules (process.argv[1] check) instead of separate bin wrapper scripts
- [03-04]: Shared bootstrap() function creates all components; tools are thin wrappers over existing managers
- [03-04]: parseArgs() exported separately from run() for unit testability without requiring relay connection
- [04-01]: BlockStore.Close() removed -- caller (main.go) owns shared DB handle via OpenDB
- [04-01]: JSON encoding for queue values (human-debuggable with bbolt CLI, write path serialized by bbolt)
- [04-01]: 5-minute sweep interval hardcoded (7-day TTL makes finer granularity negligible)
- [04-01]: Corrupt queue entries skipped in FlushBatch with slog.Warn, cleaned by sweep
- [04-02]: Immediate deletion on flush (Remove after Send) instead of deferred deletion via delivery confirmation
- [04-02]: Flushing flag uses sync/atomic for lock-free reads on hot routing path
- [04-02]: Messages during flush enqueued to bbolt (not real-time) to preserve chronological ordering
- [04-02]: PINCH_RELAY_QUEUE_MAX and PINCH_RELAY_QUEUE_TTL env vars for configurable queue settings
- [05-01]: ActivityFeed shares SQLite database via MessageStore.getDb() accessor (type-safe shared access)
- [05-01]: InboundRouter activityFeed parameter is optional (3rd param) for backward compatibility
- [05-01]: Confirmation gate for full_auto applies from any level (not just full_manual)
- [05-01]: circuitBreakerTripped cleared on any setAutonomy call (human manual override)
- [05-02]: Deny-all manifest assigned to new connections via defaultPermissionsManifest() in addConnection()
- [05-02]: Plain text messages pass structural check in v1 (future phases add structured action types)
- [05-02]: Custom category check reuses checkInformationBoundary with category description as boundary
- [05-02]: LLM failure or uncertainty always escalates to human (safe default per research pitfall 5)
- [05-03]: EnforcementPipeline is the single entry point for all inbound message processing after decryption
- [05-03]: Circuit breaker uses updateConnection() for downgrade to avoid setAutonomy() confirmation gate
- [05-03]: Auto-respond policy evaluation logs every decision to activity feed regardless of outcome
- [05-03]: Circuit breaker trip calls connectionStore.save() as fire-and-forget for persistence
- [06-01]: actionType defaults to eventType when not explicitly provided (backward compat)
- [06-01]: Genesis entry has prevHash="" -- old entries without hashes are pre-audit
- [06-01]: Muted events excluded by default in pinch_activity; --include-muted overrides for audit
- [06-01]: computeEntryHash exported for reuse by audit verification tool in later plans
- [06-02]: Token bucket via golang.org/x/time/rate (stdlib-quality, minimal dependency)
- [06-02]: Rate limit check BEFORE envelope size check for fastest rejection path
- [06-02]: Lazy limiter creation per address (memory proportional to active clients)
- [06-02]: TypeScript handler logs only (no backoff in v1 -- rate limits for obvious abuse)
- [06-04]: No changes to cli.ts bootstrap -- ActivityFeed evolves in-place via initSchema()
- [06-04]: Tail verification skips genesis prev_hash check (partial chain starts at arbitrary point)
- [06-04]: Export uses raw SQL column names (snake_case) in JSON for independent verification

### Pending Todos

None yet.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-27
Stopped at: Completed 06-04-PLAN.md
Resume file: None
