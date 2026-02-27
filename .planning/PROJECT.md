# Pinch

## What This Is

Pinch is a secure agent-to-agent messaging protocol — "Signal for agents." It enables AI agents to communicate 1:1 on behalf of their humans, with NaCl box E2E encryption, human consent at every step, and 4-tier configurable autonomy levels. The system is a monorepo with two components: a Go relay server (lightweight, cryptographically blind message router with store-and-forward) and a TypeScript OpenClaw skill (12 CLI tools for keypair management, encrypted messaging, connection handling, permissions, audit, and human intervention).

## Core Value

Agents can securely message each other with human consent and oversight at every step — no message flows without explicit human approval of the connection.

## Requirements

### Validated

- ✓ Ed25519 keypair identity with `pinch:<hash>@<relay>` addressing format — v1.0
- ✓ Connection request model — mutual approval required before any messages flow — v1.0
- ✓ Blocking, muting, and revocation of connections — v1.0
- ✓ 4-tier autonomy levels per connection (Full Manual → Notify → Auto-respond → Full Auto) — v1.0
- ✓ Inbound permissions manifest with domain-specific capability tiers — v1.0
- ✓ E2E encryption using Ed25519 signing + X25519 key exchange + NaCl box — v1.0
- ✓ 1:1 encrypted channels with real-time sub-100ms delivery — v1.0
- ✓ Human oversight: activity feed with SHA-256 hash-chained audit log — v1.0
- ✓ Human intervention: passthrough mode with message attribution — v1.0
- ✓ Rate limiting (relay-side token bucket) and circuit breaker auto-downgrade — v1.0
- ✓ Relay server: thin, self-hostable, WebSocket-based with challenge-response auth — v1.0
- ✓ Store-and-forward: bbolt message queue with 7-day TTL and ordered reconnect flush — v1.0
- ✓ OpenClaw skill: 12 CLI tools with persistent background listener via heartbeat cycle — v1.0

### Active

- [ ] Group encrypted channels with member management and key rotation
- [ ] Forward secrecy via Double Ratchet (protocol envelope already crypto-agnostic)
- [ ] Relay TLS termination and Docker packaging for self-hosters
- [ ] Structured action types beyond plain text messages

### Out of Scope

- Federation between relays — single relay instance sufficient, federation adds discovery complexity
- OAuth / third-party auth for agents — Ed25519 keypairs are the identity system
- Mobile/web UI — agents interact via skill tools, humans interact via OpenClaw's activity feed
- Payment/billing for relay usage — self-hosted, no monetization planned
- Post-quantum crypto — design is algorithm-agnostic; add PQ when ecosystem matures

## Context

- **OpenClaw**: Open-source agent framework at https://github.com/openclaw/openclaw. Skills are SKILL.md files with YAML frontmatter + markdown body, using the `message` tool pattern.
- **Skill architecture**: Two layers — (1) persistent background listener that maintains WebSocket connection to relay and processes inbound messages/requests, hooking into OpenClaw's heartbeat cycle; (2) outbound tools the agent invokes for actions (send, connect, review history).
- **Primary use case**: Agent collaboration — two people's agents coordinating on shared work (planning, research, handoffs). First connection requires mutual approval via connection request.
- **Current state**: v1.0 shipped. ~12,700 TypeScript + ~6,200 Go + 169 Protobuf lines. 12 CLI tools. 540+ tests passing. Go relay with bbolt persistence. TypeScript skill with SQLite message/activity stores.
- **Known issues**: Empty pubkey bytes in ConnectionRequest (relay auth suffices); dist/ integration test ECONNREFUSED (infra issue, not code bug).

## Constraints

- **Tech stack**: Go for relay server, TypeScript for OpenClaw skill
- **Monorepo**: `/relay` (Go) + `/skill` (TypeScript) in single repository
- **Crypto**: libsodium/NaCl primitives only — no custom cryptography
- **Relay blindness**: Relay must never have access to plaintext message content or private keys
- **OpenClaw compatibility**: Skill must follow OpenClaw skill patterns (SKILL.md, message tool, heartbeat cycle)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Simple E2E over Signal Protocol | Lower complexity for v1; NaCl box provides confidentiality and authenticity. Can upgrade crypto layer later without protocol changes. | ✓ Good — shipped fast, crypto interop proven |
| Store-and-forward + real-time | Agents aren't always online. Queue encrypted blobs at relay, deliver when connected. Real-time via WebSocket when both online. | ✓ Good — bbolt queue with ordered flush works |
| Groups deferred to v2 | Get 1:1 solid first; group key rotation adds complexity. | ✓ Good — kept scope tight |
| Connection request model | Mirrors human trust patterns. No unsolicited messages. Mutual consent before any data flows. | ✓ Good — core differentiator |
| Monorepo structure | Relay and skill are tightly coupled in protocol evolution. Single repo keeps them in sync. | ✓ Good — proto changes propagate easily |
| Ed25519 keypair identity | Standard, well-audited curve. Same keypair for signing (Ed25519) and encryption (convert to X25519). | ✓ Good — cross-language interop verified |
| Immediate deletion on flush | Delete messages from queue immediately after send, rather than waiting for delivery confirmation. | ✓ Good — simpler, eliminated dead code |
| EnforcementPipeline as single entry point | All inbound messages flow through permissions → circuit breaker → routing → policy. | ✓ Good — clean separation of concerns |
| bootstrapLocal() for local-only tools | Separate singleton from full bootstrap; no relay WebSocket for CLI tools that only need SQLite. | ✓ Good — faster startup, no relay dependency |

---
*Last updated: 2026-02-27 after v1.0 milestone*
