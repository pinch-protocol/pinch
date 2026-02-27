# Requirements: Pinch

**Defined:** 2026-02-26
**Core Value:** Agents can securely message each other with human consent and oversight at every step -- no message flows without explicit human approval of the connection.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Identity

- [x] **IDNT-01**: Agent can generate an Ed25519 keypair and persist it securely
- [x] **IDNT-02**: Agent derives a `pinch:<hash>@<relay>` address from its public key
- [x] **IDNT-03**: Agent can load an existing keypair from storage on startup

### Protocol

- [x] **PROT-01**: All wire messages use Protocol Buffers with shared `.proto` schema generating Go and TypeScript code
- [x] **PROT-02**: Protocol envelope includes a version field for future upgrades
- [x] **PROT-03**: Encrypted payloads include monotonically increasing sequence numbers for replay protection
- [x] **PROT-04**: Encrypted payloads include timestamps for replay protection and ordering

### Relay

- [x] **RELY-01**: Go relay server accepts WebSocket connections and routes encrypted blobs without inspecting content
- [x] **RELY-02**: Relay authenticates agents via Ed25519 challenge-response (relay sends nonce, agent signs, relay verifies)
- [x] **RELY-03**: Relay maintains a hub routing table mapping `pinch:` addresses to active WebSocket connections
- [ ] **RELY-04**: Relay delivers messages in real-time when both agents are online (sub-100ms relay hop)
- [ ] **RELY-05**: Relay queues encrypted messages in bbolt for offline agents with configurable TTL (7-day default)
- [ ] **RELY-06**: Relay flushes queued messages to agent on reconnection in order
- [ ] **RELY-07**: Relay enforces per-connection rate limiting (token bucket or sliding window)
- [x] **RELY-08**: Relay implements ping/pong heartbeats (20-30s interval, 5-10s pong timeout) to prevent goroutine leaks

### Encryption

- [ ] **CRYP-01**: Agent encrypts 1:1 messages using NaCl box (X25519 key exchange + XSalsa20-Poly1305)
- [x] **CRYP-02**: Agent converts Ed25519 signing keys to X25519 encryption keys using libsodium/edwards25519
- [x] **CRYP-03**: Every encrypted message uses a unique 24-byte random nonce from CSPRNG, prepended to ciphertext
- [x] **CRYP-04**: Cross-language crypto roundtrip tests pass in CI (Go encrypts/TS decrypts and vice versa)
- [ ] **CRYP-05**: Sender receives E2E signed delivery confirmation when message is delivered to recipient

### Connection

- [x] **CONN-01**: Agent can send a connection request to another agent's `pinch:` address
- [x] **CONN-02**: Receiving agent's human sees connection request and can approve or reject
- [x] **CONN-03**: On approval, agents exchange public keys and the connection is established
- [x] **CONN-04**: Agent can block a connection -- relay rejects all messages from blocked pubkey
- [ ] **CONN-05**: Agent can mute a connection -- messages still delivered but not surfaced to agent/human
- [x] **CONN-06**: Either party can revoke a connection at any time, severing the channel without blocking

### Autonomy

- [x] **AUTO-01**: Each connection has a configurable autonomy level: Full Manual, Notify, Auto-respond, or Full Auto
- [x] **AUTO-02**: New connections default to Full Manual -- human approves every inbound message
- [ ] **AUTO-03**: Full Manual: agent queues inbound messages for human approval before processing
- [ ] **AUTO-04**: Notify: agent processes messages autonomously and notifies human of actions taken
- [ ] **AUTO-05**: Auto-respond: agent handles messages within configured rules, logs everything
- [ ] **AUTO-06**: Full Auto: agent operates independently, logs to audit trail
- [ ] **AUTO-07**: Human can change autonomy level for any connection at any time
- [ ] **AUTO-08**: Inbound permissions manifest defines what message types/actions a connection can send
- [ ] **AUTO-09**: Permissions are enforced at the agent level before decrypted content reaches the LLM
- [ ] **AUTO-10**: Circuit breakers auto-downgrade autonomy level when a connection exhibits anomalous behavior

### Oversight

- [ ] **OVRS-01**: Human can view an activity feed showing all sent/received messages and connection events
- [ ] **OVRS-02**: Activity feed is filterable by connection, time range, and message type
- [ ] **OVRS-03**: Human can intervene in any conversation -- take over and send messages directly
- [ ] **OVRS-04**: Messages are attributed as agent-sent or human-sent for conversation clarity
- [ ] **OVRS-05**: Tamper-evident audit log with hash chaining records all messages and connection events
- [ ] **OVRS-06**: Audit log entries include: timestamp, actor pubkey, action type, connection ID, message hash

### Skill Integration

- [ ] **SKIL-01**: OpenClaw SKILL.md definition with YAML frontmatter and markdown body
- [ ] **SKIL-02**: Persistent background listener maintains WebSocket connection via OpenClaw heartbeat cycle
- [ ] **SKIL-03**: Outbound tools follow standard OpenClaw skill patterns (pinch_send, pinch_connect, pinch_history, etc.)
- [ ] **SKIL-04**: Skill processes inbound messages/requests and routes based on autonomy level

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Group Messaging

- **GRPM-01**: Agent can create a group channel and invite other connected agents
- **GRPM-02**: Group messages encrypted with shared symmetric key (NaCl secretbox) with server-side fan-out
- **GRPM-03**: Group membership management -- add/remove members
- **GRPM-04**: Mandatory key rotation on member removal
- **GRPM-05**: Autonomy and permissions apply per-connection within groups

### Security Upgrades

- **SECU-01**: Forward secrecy via Double Ratchet (protocol envelope already crypto-agnostic)
- **SECU-02**: Key backup and encrypted export/import for identity portability
- **SECU-03**: Post-quantum hybrid encryption when libraries stabilize

### Infrastructure

- **INFR-01**: Relay federation between multiple relay instances
- **INFR-02**: Relay TLS termination and Docker packaging for self-hosters

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| OAuth / third-party auth | Ed25519 keypairs are the identity system -- self-sovereign, no external IdP dependency |
| Mobile/web client UI | Agents interact via skill tools, humans via OpenClaw activity feed -- not a chat app |
| Rich media rendering | Agents exchange text, files, and action confirmations -- no format negotiation needed |
| Payment/billing at relay | Self-hosted relays, no monetization in v1 |
| Agent capability discovery | Pinch is messaging, not discovery -- connection requests carry human-readable descriptions |
| Post-quantum crypto (v1) | Design envelope to be algorithm-agnostic; add PQ when ecosystem matures |
| Relay federation (v1) | `pinch:<hash>@<relay>` address format already encodes relay identity for future federation |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| IDNT-01 | Phase 1 | Complete |
| IDNT-02 | Phase 1 | Complete |
| IDNT-03 | Phase 1 | Complete |
| PROT-01 | Phase 1 | Complete |
| PROT-02 | Phase 1 | Complete |
| PROT-03 | Phase 1 | Complete |
| PROT-04 | Phase 1 | Complete |
| RELY-01 | Phase 1 | Complete |
| RELY-02 | Phase 2 | Complete |
| RELY-03 | Phase 1 | Complete |
| RELY-04 | Phase 3 | Pending |
| RELY-05 | Phase 4 | Pending |
| RELY-06 | Phase 4 | Pending |
| RELY-07 | Phase 6 | Pending |
| RELY-08 | Phase 1 | Complete |
| CRYP-01 | Phase 3 | Pending |
| CRYP-02 | Phase 1 | Complete |
| CRYP-03 | Phase 1 | Complete |
| CRYP-04 | Phase 1 | Complete |
| CRYP-05 | Phase 3 | Pending |
| CONN-01 | Phase 2 | Complete |
| CONN-02 | Phase 2 | Complete |
| CONN-03 | Phase 2 | Complete |
| CONN-04 | Phase 2 | Complete |
| CONN-05 | Phase 6 | Pending |
| CONN-06 | Phase 2 | Complete |
| AUTO-01 | Phase 2 | Complete |
| AUTO-02 | Phase 2 | Complete |
| AUTO-03 | Phase 5 | Pending |
| AUTO-04 | Phase 5 | Pending |
| AUTO-05 | Phase 5 | Pending |
| AUTO-06 | Phase 5 | Pending |
| AUTO-07 | Phase 5 | Pending |
| AUTO-08 | Phase 5 | Pending |
| AUTO-09 | Phase 5 | Pending |
| AUTO-10 | Phase 5 | Pending |
| OVRS-01 | Phase 6 | Pending |
| OVRS-02 | Phase 6 | Pending |
| OVRS-03 | Phase 6 | Pending |
| OVRS-04 | Phase 6 | Pending |
| OVRS-05 | Phase 6 | Pending |
| OVRS-06 | Phase 6 | Pending |
| SKIL-01 | Phase 3 | Pending |
| SKIL-02 | Phase 3 | Pending |
| SKIL-03 | Phase 3 | Pending |
| SKIL-04 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 46 total
- Mapped to phases: 46
- Unmapped: 0

---
*Requirements defined: 2026-02-26*
*Last updated: 2026-02-26 after roadmap creation*
