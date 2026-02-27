# Roadmap: Pinch

## Overview

Pinch delivers secure agent-to-agent messaging in six phases following the dependency chain from cryptographic primitives up through human oversight. Phases 1-3 are the critical path to "proof of life" (two agents exchanging encrypted messages). Phase 4 makes the system usable for real workflows (offline agents). Phase 5 completes Pinch's core differentiator (graduated autonomy with permissions). Phase 6 adds the safety and audit infrastructure required before any external exposure.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation and Crypto Primitives** - Monorepo scaffold, protobuf wire format, Ed25519 identity, relay WebSocket skeleton, cross-language crypto tests (completed 2026-02-27)
- [x] **Phase 2: Authentication and Connection** - Challenge-response auth, connection request lifecycle, blocking, baseline autonomy (Full Manual + Full Auto) (completed 2026-02-27)
- [x] **Phase 3: Encrypted 1:1 Messaging** - NaCl box E2E encryption, real-time message delivery, OpenClaw skill integration (completed 2026-02-27)
- [ ] **Phase 4: Store-and-Forward** - bbolt message queue at relay, TTL expiration, reconnect flush, delivery confirmations
- [x] **Phase 5: Full Autonomy and Permissions** - 4-tier autonomy state machine, inbound permissions manifest, autonomy change controls (completed 2026-02-27)
- [ ] **Phase 6: Oversight and Safety** - Activity feed, human intervention, audit log with hash chaining, rate limiting, circuit breakers, muting

## Phase Details

### Phase 1: Foundation and Crypto Primitives
**Goal**: A working monorepo where Go relay accepts WebSocket connections, TypeScript skill connects, Ed25519 keypairs generate addresses, protobuf messages serialize cross-language, and crypto roundtrip tests pass in CI
**Depends on**: Nothing (first phase)
**Requirements**: IDNT-01, IDNT-02, IDNT-03, PROT-01, PROT-02, PROT-03, PROT-04, RELY-01, RELY-03, RELY-08, CRYP-02, CRYP-03, CRYP-04
**Success Criteria** (what must be TRUE):
  1. Agent generates an Ed25519 keypair, persists it, and reloads it on restart -- the same `pinch:<hash>@<relay>` address appears both times
  2. Go relay starts, accepts a WebSocket connection from the TypeScript skill, and maintains it with ping/pong heartbeats (no goroutine leaks on disconnect)
  3. A protobuf-encoded message created in Go deserializes correctly in TypeScript and vice versa, including version field, sequence number, and timestamp fields
  4. Go encrypts a payload with NaCl box using an Ed25519-derived X25519 key and random nonce; TypeScript decrypts it successfully (and vice versa) -- this roundtrip test passes in CI
  5. Relay maintains a routing table mapping `pinch:` addresses to active WebSocket connections
**Plans**: 3 plans

Plans:
- [ ] 01-01-PLAN.md — Monorepo scaffold, protobuf schema, and cross-language code generation
- [ ] 01-02-PLAN.md — Ed25519 identity, NaCl box crypto, and cross-language roundtrip tests (TDD)
- [ ] 01-03-PLAN.md — WebSocket relay hub with heartbeat and TypeScript client

### Phase 2: Authentication and Connection
**Goal**: Agents authenticate to the relay via Ed25519 challenge-response and can establish mutual-consent connections with each other, with blocking enforced at the relay level
**Depends on**: Phase 1
**Requirements**: RELY-02, CONN-01, CONN-02, CONN-03, CONN-04, CONN-06, AUTO-01, AUTO-02
**Success Criteria** (what must be TRUE):
  1. Agent connects to relay, receives a nonce challenge, signs it with Ed25519 private key, and relay verifies the signature and registers the agent's `pinch:` address
  2. Agent A sends a connection request to Agent B's `pinch:` address; Agent B's human sees the request and can approve or reject it; on approval both agents exchange public keys
  3. Agent can block a connection and the relay rejects all subsequent messages from the blocked pubkey; agent can revoke a connection (sever without blocking)
  4. New connections default to Full Manual autonomy; autonomy level (Full Manual or Full Auto) is configurable per connection and persisted
**Plans**: 4 plans

Plans:
- [ ] 02-01-PLAN.md — Proto schema extension (auth, connection, block, revoke messages) and relay Ed25519 challenge-response auth
- [ ] 02-02-PLAN.md — bbolt block store and hub message routing with block enforcement
- [ ] 02-03-PLAN.md — TypeScript auth handshake, RelayClient rewrite, and JSON connection store with autonomy
- [ ] 02-04-PLAN.md — ConnectionManager lifecycle (request/approve/reject/block/revoke) and cross-language integration tests

### Phase 3: Encrypted 1:1 Messaging
**Goal**: Two agents exchange end-to-end encrypted messages through the relay in real time, with the relay seeing only ciphertext, integrated as an OpenClaw skill
**Depends on**: Phase 2
**Requirements**: CRYP-01, CRYP-05, RELY-04, SKIL-01, SKIL-02, SKIL-03, SKIL-04
**Success Criteria** (what must be TRUE):
  1. Agent A sends an encrypted message to Agent B; Agent B decrypts it and sees the plaintext; the relay at no point has access to plaintext or private keys
  2. Real-time message delivery achieves sub-100ms relay hop when both agents are online
  3. Sender receives an E2E signed delivery confirmation when the recipient receives the message
  4. The OpenClaw SKILL.md definition exists with proper YAML frontmatter; the skill maintains a persistent WebSocket connection via heartbeat cycle; outbound tools (pinch_send, pinch_connect, pinch_history) follow OpenClaw patterns
  5. Inbound messages are routed based on connection autonomy level -- Full Manual queues for human approval, Full Auto processes immediately
**Plans**: 4 plans

Plans:
- [ ] 03-01-PLAN.md -- DeliveryConfirm proto schema, relay 64KB enforcement, 30-second transient buffer
- [ ] 03-02-PLAN.md -- SQLite message store, delivery confirmation signing, public key exchange fix
- [ ] 03-03-PLAN.md -- MessageManager encrypt/decrypt orchestration, InboundRouter, RelayClient reconnection
- [ ] 03-04-PLAN.md -- Five OpenClaw skill tools, SKILL.md, HEARTBEAT.md, integration tests

### Phase 4: Store-and-Forward
**Goal**: Agents that go offline receive all messages sent while they were away, in order, when they reconnect
**Depends on**: Phase 3
**Requirements**: RELY-05, RELY-06
**Success Criteria** (what must be TRUE):
  1. When Agent B is offline, messages sent by Agent A are queued at the relay in bbolt with a 7-day default TTL; expired messages are cleaned up
  2. When Agent B reconnects, all queued messages are flushed to it in the order they were sent; no messages are lost or duplicated
**Plans**: 2 plans

Plans:
- [ ] 04-01-PLAN.md -- Proto schema extensions (QueueStatus, QueueFull, was_stored), shared bbolt DB opener, MessageQueue store with TTL sweep
- [ ] 04-02-PLAN.md -- Hub integration with batched flush, flushing state, queue-full feedback, TypeScript handling, cross-language integration tests

### Phase 5: Full Autonomy and Permissions
**Goal**: Every connection has a graduated autonomy level (Full Manual / Notify / Auto-respond / Full Auto) enforced by the agent, with an inbound permissions manifest controlling what each connection can send
**Depends on**: Phase 3
**Requirements**: AUTO-03, AUTO-04, AUTO-05, AUTO-06, AUTO-07, AUTO-08, AUTO-09, AUTO-10
**Success Criteria** (what must be TRUE):
  1. Full Manual queues every inbound message for human approval; Notify processes autonomously and notifies human; Auto-respond handles within configured rules and logs; Full Auto operates independently with audit trail
  2. Human can change the autonomy level for any connection at any time; the change takes effect immediately
  3. Inbound permissions manifest defines what message types and actions a connection can send; permissions are enforced before decrypted content reaches the LLM
  4. Circuit breakers auto-downgrade a connection's autonomy level when anomalous behavior is detected (e.g., message flood, unexpected action types)
**Plans**: 3 plans

Plans:
- [ ] 05-01-PLAN.md -- Extend autonomy to 4 tiers, InboundRouter 4-branch routing, ActivityFeed, pinch-autonomy tool
- [ ] 05-02-PLAN.md -- PermissionsManifest with domain-specific capability tiers, PermissionsEnforcer, PolicyEvaluator interface, pinch-permissions tool
- [ ] 05-03-PLAN.md -- CircuitBreaker with sliding window counters, EnforcementPipeline wiring, bootstrap update, SKILL.md/HEARTBEAT.md updates

### Phase 6: Oversight and Safety
**Goal**: Humans have full visibility into agent communication via an activity feed and audit log, can intervene in conversations, and the system is protected by rate limiting and circuit breakers
**Depends on**: Phase 5
**Requirements**: OVRS-01, OVRS-02, OVRS-03, OVRS-04, OVRS-05, OVRS-06, RELY-07, CONN-05
**Success Criteria** (what must be TRUE):
  1. Human can view a chronological activity feed of all sent/received messages and connection events, filterable by connection, time range, and message type
  2. Human can intervene in any conversation -- take over and send messages directly; messages are attributed as agent-sent or human-sent
  3. Tamper-evident audit log with hash chaining records all messages and connection events with timestamp, actor pubkey, action type, connection ID, and message hash
  4. Relay enforces per-connection rate limiting (token bucket or sliding window); excessive requests are rejected
  5. Agent can mute a connection -- messages still delivered but not surfaced to agent or human
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation and Crypto Primitives | 3/3 | Complete    | 2026-02-27 |
| 2. Authentication and Connection | 4/4 | Complete    | 2026-02-27 |
| 3. Encrypted 1:1 Messaging | 1/4 | Complete    | 2026-02-27 |
| 4. Store-and-Forward | 2/2 | Complete    | 2026-02-27 |
| 5. Full Autonomy and Permissions | 0/3 | Complete    | 2026-02-27 |
| 6. Oversight and Safety | 0/2 | Not started | - |
