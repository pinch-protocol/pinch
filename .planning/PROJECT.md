# Pinch

## What This Is

Pinch is a secure agent-to-agent messaging protocol — "Signal for agents." It enables AI agents to communicate 1:1 and in groups on behalf of their humans, with end-to-end encryption, human consent at every step, and configurable autonomy levels. The system is a monorepo with two components: a Go relay server (lightweight, cryptographically blind message router) and a TypeScript OpenClaw skill (keypair management, encryption, connection handling).

## Core Value

Agents can securely message each other with human consent and oversight at every step — no message flows without explicit human approval of the connection.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. -->

- [ ] Ed25519 keypair identity with `pinch:<hash>@<relay>` addressing format
- [ ] Connection request model — mutual approval required before any messages flow
- [ ] Blocking and muting of connections
- [ ] 4-tier autonomy levels per connection (Full Manual → Notify → Auto-respond → Full Auto)
- [ ] Inbound permissions manifest — what types of messages/actions a connection can send
- [ ] E2E encryption using Ed25519 signing + X25519 key exchange + NaCl secretbox
- [ ] Message types: text, files, action confirmations
- [ ] 1:1 encrypted channels
- [ ] Group encrypted channels with member management
- [ ] Human oversight: activity feed showing all agent communication
- [ ] Human intervention: ability to step in and override agent actions
- [ ] Audit log of all messages and connection events
- [ ] Rate limiting and circuit breakers per connection
- [ ] Relay server: thin, stateless, self-hostable, WebSocket-based
- [ ] Store-and-forward: relay queues encrypted messages for offline agents
- [ ] Real-time delivery when both agents are online
- [ ] OpenClaw skill: persistent background listener via heartbeat cycle
- [ ] OpenClaw skill: outbound tools (send message, manage connections, review history)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Forward secrecy / Signal double ratchet — v1 uses simple NaCl box E2E, can upgrade crypto later without protocol changes
- Federation between relays — single relay instance for v1, federation adds discovery complexity
- OAuth / third-party auth for agents — Ed25519 keypairs are the identity system
- Mobile/web UI — agents interact via skill tools, humans interact via OpenClaw's activity feed
- Payment/billing for relay usage — self-hosted, no monetization in v1

## Context

- **OpenClaw**: Open-source agent framework at https://github.com/openclaw/openclaw. Skills are SKILL.md files with YAML frontmatter + markdown body, using the `message` tool pattern.
- **Skill architecture**: Two layers — (1) persistent background listener that maintains WebSocket connection to relay and processes inbound messages/requests, hooking into OpenClaw's heartbeat cycle; (2) outbound tools the agent invokes for actions (send, connect, review history).
- **Primary use case**: Agent collaboration — two people's agents coordinating on shared work (planning, research, handoffs). First connection requires mutual approval via connection request.
- **"Done" milestones**: Milestone 1 is two agents exchanging encrypted messages through the relay (internal proof of life). Launch-ready means a developer can install the skill and connect two agents with minimal config. Launch demo is a collaboration flow video.

## Constraints

- **Tech stack**: Go for relay server, TypeScript for OpenClaw skill
- **Monorepo**: `/relay` (Go) + `/skill` (TypeScript) in single repository
- **Crypto**: libsodium/NaCl primitives only — no custom cryptography
- **Relay blindness**: Relay must never have access to plaintext message content or private keys
- **OpenClaw compatibility**: Skill must follow OpenClaw skill patterns (SKILL.md, message tool, heartbeat cycle)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Simple E2E over Signal Protocol | Lower complexity for v1; NaCl box provides confidentiality and authenticity. Can upgrade crypto layer later without protocol changes. | — Pending |
| Store-and-forward + real-time | Agents aren't always online. Queue encrypted blobs at relay, deliver when connected. Real-time via WebSocket when both online. | — Pending |
| Groups in v1 | Multi-agent collaboration is the primary use case. 1:1 alone is insufficient for coordinating shared work. | — Pending |
| Connection request model | Mirrors human trust patterns. No unsolicited messages. Mutual consent before any data flows. | — Pending |
| Monorepo structure | Relay and skill are tightly coupled in protocol evolution. Single repo keeps them in sync. | — Pending |
| Ed25519 keypair identity | Standard, well-audited curve. Same keypair for signing (Ed25519) and encryption (convert to X25519). | — Pending |

---
*Last updated: 2026-02-26 after initialization*
