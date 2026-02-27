---
phase: 05-full-autonomy-and-permissions
verified: 2026-02-27T00:44:00Z
status: gaps_found
score: 21/22 must-haves verified
gaps:
  - truth: "SKILL.md documents the correct permission tier names matching the actual code"
    status: failed
    reason: "SKILL.md Permissions section documents wrong enum values for Calendar, Files, and Actions tiers -- the doc says 'read'/'read_write'/'execute' but the actual PermissionsManifest type uses 'full_details'/'propose_and_book'/'specific_folders'/'everything'/'scoped'/'full'"
    artifacts:
      - path: "skill/SKILL.md"
        issue: "Lines 259-278: Calendar tiers show 'read, read_write' (should be 'full_details, propose_and_book'); Files show 'read, read_write' (should be 'specific_folders, everything'); Actions show 'read, execute' (should be 'scoped, full')"
    missing:
      - "Update SKILL.md lines 259-278 to show correct tier names: calendar: none|free_busy_only|full_details|propose_and_book, files: none|specific_folders|everything, actions: none|scoped|full"
---

# Phase 5: Full Autonomy and Permissions Verification Report

**Phase Goal:** Every connection has a graduated autonomy level (Full Manual / Notify / Auto-respond / Full Auto) enforced by the agent, with an inbound permissions manifest controlling what each connection can send
**Verified:** 2026-02-27T00:44:00Z
**Status:** gaps_found
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Full Manual queues every inbound message for human approval (no TTL) | VERIFIED | `inbound-router.ts:98` sets state to `escalated_to_human` for `full_manual`; no expiry logic |
| 2 | Notify processes autonomously and creates activity feed entry with `processed_autonomously` badge | VERIFIED | `inbound-router.ts:82-88` sets state `read_by_agent` and calls `activityFeed?.record()` with `badge: 'processed_autonomously'` |
| 3 | Auto-respond marks message `pending_policy_eval` and routes through PolicyEvaluator | VERIFIED | `inbound-router.ts:91-92` sets `pending_policy_eval`; `enforcement-pipeline.ts:114-120` calls `evaluateAutoRespondPolicy()` |
| 4 | Full Auto processes independently and logs to audit trail | VERIFIED | `inbound-router.ts:76-77` sets `read_by_agent`; activity feed records all autonomy events |
| 5 | Human can change autonomy level via `pinch-autonomy` tool at any time; change takes effect immediately | VERIFIED | `pinch-autonomy.ts:97` calls `connectionStore.setAutonomy()`; `connection-store.ts:248` returns updated connection; InboundRouter reads fresh level on each `route()` call |
| 6 | Inbound permissions manifest defines what a connection can send; enforced before content reaches LLM | VERIFIED | `permissions-enforcer.ts:40-134` runs before autonomy routing; `enforcement-pipeline.ts:51-54` calls `permissionsEnforcer.check()` as step 1 |
| 7 | Deny-all default manifest assigned to every new connection | VERIFIED | `connection-store.ts:164-165` assigns `defaultPermissionsManifest()` in `addConnection()` |
| 8 | Information boundaries evaluated by PolicyEvaluator; uncertain results block and escalate | VERIFIED | `permissions-enforcer.ts:70-95` calls `policyEvaluator.checkInformationBoundary()` and returns `escalateToHuman: true` for `escalate` action |
| 9 | LLM unavailability in Auto-respond falls back to escalated_to_human | VERIFIED | `enforcement-pipeline.ts:195-203` catches exceptions and sets `escalated_to_human`; `NoOpPolicyEvaluator` returns `escalate` |
| 10 | Circuit breakers auto-downgrade to Full Manual on anomalous behavior | VERIFIED | `circuit-breaker.ts:186-188` calls `connectionStore.updateConnection()` with `autonomyLevel: 'full_manual'` on trip |
| 11 | All four circuit breaker triggers active: message_flood, permission_violation, spending_exceeded, boundary_probe | VERIFIED | `circuit-breaker.ts:131-156` defines all four trigger checks with configurable thresholds |
| 12 | Circuit breaker trip is straight to Full Manual (no gradual step-down) | VERIFIED | `circuit-breaker.ts:186-188` jumps directly to `full_manual`; no intermediate step logic |
| 13 | Human must manually re-upgrade after circuit breaker trips | VERIFIED | `connection-store.ts:244-246` `setAutonomy()` clears `circuitBreakerTripped` on any manual call; no automatic recovery code |
| 14 | Circuit breaker trip appears in activity feed with trigger details and warning badge | VERIFIED | `circuit-breaker.ts:200-210` calls `activityFeed.record()` with `badge: 'circuit_breaker'` and JSON trigger details |
| 15 | `circuitBreakerTripped` persists across restarts | VERIFIED | `circuit-breaker.ts:191-192` sets flag via `connectionStore.updateConnection()`; `connectionStore.ts:197` saves `save()` at line 197; field is in JSON store |
| 16 | Enforcement pipeline order: permissions -> circuit breaker -> autonomy routing | VERIFIED | `enforcement-pipeline.ts:51,105,111` shows three sequential steps in exact order |
| 17 | Auto-respond policy evaluation logs every decision to activity feed with action, confidence, and reasoning | VERIFIED | `enforcement-pipeline.ts:216-226` `recordAutoRespondDecision()` records `auto_respond_decision` with `badge: 'auto_respond'` and details JSON for ALL outcomes (allow, deny, escalate, error) |
| 18 | MessageManager routes inbound messages through `enforcementPipeline.process()` not `inboundRouter.route()` directly | VERIFIED | `message-manager.ts:230` `await this.enforcementPipeline.process(messageRecord, senderAddress)` |
| 19 | Bootstrap creates all new autonomy components and wires them into the pipeline | VERIFIED | `cli.ts:85-110` creates ActivityFeed, PermissionsEnforcer, CircuitBreaker, InboundRouter, EnforcementPipeline, and passes `enforcementPipeline` to MessageManager |
| 20 | SKILL.md documents all 4 autonomy levels with correct behaviors | VERIFIED | `SKILL.md:222-228` has Full Manual, Notify, Auto-respond, Full Auto table with correct behavior descriptions |
| 21 | SKILL.md documents pinch-autonomy and pinch-permissions tools | VERIFIED | `SKILL.md:230-285` has tool documentation for both CLI tools |
| 22 | SKILL.md permission tier names match actual code | FAILED | SKILL.md lines 259-278 documents wrong tier names (old drafts: `read`/`read_write`/`execute`) instead of actual code values (`full_details`/`propose_and_book`/`specific_folders`/`everything`/`scoped`/`full`) |

**Score:** 21/22 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `skill/src/connection-store.ts` | AutonomyLevel 4 tiers, autoRespondPolicy, circuitBreakerTripped | VERIFIED | `AutonomyLevel = "full_manual" \| "notify" \| "auto_respond" \| "full_auto"` at line 32; fields at lines 47-51 |
| `skill/src/inbound-router.ts` | 4-tier routing with notify and auto_respond branches | VERIFIED | Switch statement with all 4 cases at lines 75-100; `getPendingPolicyEval()` at line 131 |
| `skill/src/autonomy/activity-feed.ts` | ActivityFeed class with SQLite persistence | VERIFIED | Full `ActivityFeed` class with `record()` and `getEvents()` at lines 29-148 |
| `skill/src/tools/pinch-autonomy.ts` | CLI tool for setting autonomy level | VERIFIED | Full CLI tool with `parseArgs()` and `run()` functions; all 4 levels validated |
| `skill/src/autonomy/permissions-manifest.ts` | PermissionsManifest with domain capability tiers | VERIFIED | Full type definitions with `defaultPermissionsManifest()` and `validateManifest()` |
| `skill/src/autonomy/permissions-enforcer.ts` | PermissionsEnforcer gating before LLM | VERIFIED | `PermissionsEnforcer.check()` runs structural + LLM boundary checks; handles LLM failures safely |
| `skill/src/autonomy/policy-evaluator.ts` | PolicyEvaluator interface + NoOpPolicyEvaluator | VERIFIED | Interface and `NoOpPolicyEvaluator` class both present; NoOp returns `escalate` for all calls |
| `skill/src/tools/pinch-permissions.ts` | CLI tool for configuring permissions | VERIFIED | Full CLI with all operations: show, calendar, files, actions, spending, boundaries, categories |
| `skill/src/autonomy/circuit-breaker.ts` | CircuitBreaker with 4 trigger types | VERIFIED | All 4 triggers with configurable sliding window; `trip()` method downgrades and logs |
| `skill/src/autonomy/enforcement-pipeline.ts` | EnforcementPipeline wiring permissions -> CB -> routing | VERIFIED | `process()` orchestrates all 4 steps; handles all policy evaluation paths |
| `skill/src/tools/cli.ts` | Bootstrap creating all autonomy components | VERIFIED | Lines 85-110 create and wire all components; `EnforcementPipeline` in `BootstrapResult` interface |
| `skill/SKILL.md` | Autonomy levels, permissions, tools, circuit breakers documented | PARTIAL | Autonomy levels, tools, circuit breakers correct; Permission tier names are wrong (see gap) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `inbound-router.ts` | `autonomy/activity-feed.ts` | `activityFeed?.record()` in notify branch | VERIFIED | `inbound-router.ts:83` calls `this.activityFeed?.record()` with `badge: 'processed_autonomously'` |
| `tools/pinch-autonomy.ts` | `connection-store.ts` | `connectionStore.setAutonomy()` | VERIFIED | `pinch-autonomy.ts:97` calls `connectionStore.setAutonomy(parsed.address, parsed.level, ...)` |
| `permissions-enforcer.ts` | `connection-store.ts` | reads `permissionsManifest` from connection | VERIFIED | `permissions-enforcer.ts:53` accesses `connection.permissionsManifest` |
| `permissions-enforcer.ts` | `policy-evaluator.ts` | `policyEvaluator.checkInformationBoundary()` | VERIFIED | `permissions-enforcer.ts:72,106` calls `this.policyEvaluator.checkInformationBoundary()` |
| `connection-store.ts` | `autonomy/permissions-manifest.ts` | `defaultPermissionsManifest()` in `addConnection()` | VERIFIED | `connection-store.ts:164-165` assigns `defaultPermissionsManifest()` for new connections |
| `enforcement-pipeline.ts` | `permissions-enforcer.ts` | permissions check as first step | VERIFIED | `enforcement-pipeline.ts:51` `this.permissionsEnforcer.check(message.body, connectionAddress)` |
| `enforcement-pipeline.ts` | `circuit-breaker.ts` | recording events and checking trip state | VERIFIED | `enforcement-pipeline.ts:78,105` `circuitBreaker.recordViolation()` and `recordMessage()` |
| `enforcement-pipeline.ts` | `inbound-router.ts` | autonomy routing as final step | VERIFIED | `enforcement-pipeline.ts:111` `this.inboundRouter.route(message, connectionAddress)` |
| `circuit-breaker.ts` | `connection-store.ts` | auto-downgrade sets autonomy to full_manual | VERIFIED | `circuit-breaker.ts:186-188` `connectionStore.updateConnection(connectionAddress, { autonomyLevel: 'full_manual' })` |
| `tools/cli.ts` | `autonomy/enforcement-pipeline.ts` | bootstrap creates pipeline | VERIFIED | `cli.ts:90` `new EnforcementPipeline(...)` |
| `message-manager.ts` | `autonomy/enforcement-pipeline.ts` | routes via `enforcementPipeline.process()` | VERIFIED | `message-manager.ts:230` `await this.enforcementPipeline.process(messageRecord, senderAddress)` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| AUTO-03 | 05-01 | Full Manual: agent queues inbound messages for human approval | SATISFIED | `inbound-router.ts:95-99` routes to `escalated_to_human`; no TTL on queue |
| AUTO-04 | 05-01 | Notify: agent processes autonomously, notifies human | SATISFIED | `inbound-router.ts:80-89` routes to `read_by_agent` and records activity feed entry |
| AUTO-05 | 05-02 | Auto-respond: agent handles messages within configured rules, logs everything | SATISFIED | `enforcement-pipeline.ts:114-205` full policy evaluation with activity feed logging on every outcome |
| AUTO-06 | 05-01 | Full Auto: agent operates independently, logs to audit trail | SATISFIED | `inbound-router.ts:76-78` routes to `read_by_agent`; all events logged through activity feed |
| AUTO-07 | 05-01 | Human can change autonomy level for any connection at any time | SATISFIED | `pinch-autonomy.ts:97` calls `connectionStore.setAutonomy()` which writes immediately; router reads fresh state |
| AUTO-08 | 05-02 | Inbound permissions manifest defines what message types/actions a connection can send | SATISFIED | `permissions-manifest.ts` defines full manifest type; `connection-store.ts:164-165` assigns default |
| AUTO-09 | 05-02 | Permissions enforced at agent level before decrypted content reaches LLM | SATISFIED | `enforcement-pipeline.ts:51` runs permissions check before routing/policy evaluation |
| AUTO-10 | 05-03 | Circuit breakers auto-downgrade autonomy when connection exhibits anomalous behavior | SATISFIED | `circuit-breaker.ts` with 4 trigger types; `enforcement-pipeline.ts:105` records each message |

**All 8 requirements (AUTO-03 through AUTO-10) satisfied.**

### Anti-Patterns Found

| File | Lines | Pattern | Severity | Impact |
|------|-------|---------|----------|--------|
| `skill/SKILL.md` | 259-278 | Wrong permission tier names in documentation | Warning | Does not affect runtime behavior; agent using SKILL.md as reference could attempt invalid tier values |

**Notes on anti-pattern:**
- `SKILL.md` documents `read`/`read_write` for calendar and files, `read`/`execute` for actions
- Actual `PermissionsManifest` type uses `full_details`/`propose_and_book` for calendar, `specific_folders`/`everything` for files, `scoped`/`full` for actions
- The `pinch-permissions` CLI tool validates against actual type values (it would reject the documented values), making the documentation misleading

### Human Verification Required

None needed -- all core behaviors are verifiable programmatically through tests and code inspection.

### Test Results

All 221 tests pass across 23 test files:
- `connection-store.test.ts` -- 4-tier autonomy, autoRespondPolicy, circuitBreakerTripped
- `autonomy/activity-feed.test.ts` -- SQLite persistence, UUIDv7, indexed queries
- `inbound-router.test.ts` -- all 4 routing branches, activity feed integration
- `tools/pinch-autonomy.test.ts` -- CLI parsing, validation, confirmation gate
- `autonomy/permissions-manifest.test.ts` -- deny-all defaults, validation
- `autonomy/permissions-enforcer.test.ts` -- information boundary checks, LLM failure fallback
- `autonomy/policy-evaluator.test.ts` -- NoOpPolicyEvaluator safe defaults
- `tools/pinch-permissions.test.ts` -- full CLI argument parsing
- `autonomy/circuit-breaker.test.ts` -- all 4 triggers, sliding window, persistence, activity feed
- `autonomy/enforcement-pipeline.test.ts` -- all pipeline paths, policy evaluation outcomes
- `message-manager.test.ts` -- updated to use EnforcementPipeline mock
- `message-manager.integration.test.ts` -- full pipeline in integration tests

### Gaps Summary

One gap blocks a complete passing status:

**SKILL.md permission tier names are wrong.** The Permissions section documents tier values that do not match the actual `PermissionsManifest` TypeScript type. An agent reading SKILL.md to construct a `pinch-permissions` command would use invalid values (`--calendar read` instead of `--calendar full_details`), causing a validation error. The runtime behavior is unaffected since validation uses the TypeScript type, but the documentation is misleading.

This is a documentation correctness issue, not a runtime bug. However, since SKILL.md is an agent-facing interface (it is the primary way the OpenClaw agent learns how to use Pinch), incorrect tier names mean the documentation cannot be trusted for the permissions feature.

---

_Verified: 2026-02-27T00:44:00Z_
_Verifier: Claude (gsd-verifier)_
