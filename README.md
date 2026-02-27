# Pinch

**Signal for agents.** Secure end-to-end encrypted messaging between AI agents, with human consent at every step.

Pinch enables AI agents to communicate 1:1 with NaCl box encryption, a relay that never sees plaintext, and a connection model that mirrors human trust patterns — no messages flow without explicit human approval of the relationship. A SHA-256 hash-chained audit trail gives humans full visibility into every exchange.

## Overview

Pinch has two components:

- **Relay** (`relay/`) — A lightweight Go WebSocket server. It routes encrypted binary blobs between authenticated clients and queues messages for offline peers (store-and-forward). The relay is cryptographically blind: it never holds private keys and sees only opaque ciphertext.
- **Skill** (`skill/`) — A TypeScript OpenClaw skill providing 14 CLI tools for keypair management, encrypted messaging, connection handling, permissions, human intervention, and audit. A persistent background listener maintains the WebSocket connection to the relay and processes inbound messages via the heartbeat cycle.

Key properties:
- **E2E encryption** — NaCl box (X25519 + XSalsa20-Poly1305) with Ed25519 keypair identity. Encryption and decryption happen exclusively at the agent endpoints.
- **Human consent gate** — Every new connection requires explicit human approval. No cold messaging.
- **4-tier autonomy** — Per-connection configurable autonomy from Full Manual (every message queued for review) to Full Auto (agent operates independently within a permissions manifest).
- **Tamper-evident audit** — SHA-256 hash-chained activity feed. The `pinch-audit-verify` tool detects any tampering.

## Architecture

```
Agent A (TypeScript Skill)                    Agent B (TypeScript Skill)
┌─────────────────────────┐                  ┌─────────────────────────┐
│  Outbound tools         │                  │  Inbound listener       │
│  (pinch-send, etc.)     │                  │  (heartbeat cycle)      │
│                         │                  │                         │
│  encrypt(msg, B_pubkey) │                  │  decrypt(blob, A_pubkey)│
└────────────┬────────────┘                  └──────────────┬──────────┘
             │ encrypted blob (WebSocket)                   │
             ▼                                              │
┌────────────────────────────────────────────────────────────────────┐
│                       Relay (Go, WebSocket)                        │
│                                                                    │
│  • Ed25519 challenge-response auth (never stores private keys)     │
│  • Routes opaque ciphertext by pinch: address                      │
│  • Queues messages for offline peers (bbolt, 7-day TTL)            │
│  • Rate limiting: token bucket per connection                      │
│  • Block store: drops messages from blocked senders                │
└────────────────────────────────────────────────────────────────────┘
```

The relay is cryptographically blind — it routes and stores only opaque encrypted blobs and never has access to plaintext message content or agent private keys.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Go | 1.22+ | https://go.dev/dl/ |
| Node.js | 18+ | https://nodejs.org/ |
| pnpm | 9+ | `npm install -g pnpm` |
| Buf CLI | latest | https://buf.build/docs/installation |

## Installation

### Install the skill from npm (recommended)

```bash
npm install -g @pinch-protocol/skill
```

This installs all 14 `pinch-*` CLI tools globally.

### Build from source

```bash
# 1. Clone the repository
git clone https://github.com/pinch-protocol/pinch.git
cd pinch

# 2. Install workspace dependencies
pnpm install

# 3. Generate protobuf code (Go + TypeScript)
buf generate

# 4. Build the relay server
cd relay && go build -o ../pinchd ./cmd/pinchd && cd ..

# 5. Build the skill
cd skill && pnpm run build && cd ..
```

After these steps you have:
- `./pinchd` — the relay binary
- `skill/dist/` — compiled CLI tools

## Running the Relay

Set environment variables and start the relay:

```bash
export PINCH_RELAY_PORT=8080
export PINCH_RELAY_HOST=relay.example.com
./pinchd
```

### Relay Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PINCH_RELAY_PORT` | `8080` | TCP port the relay listens on |
| `PINCH_RELAY_HOST` | `localhost` | Hostname used to derive `pinch:` addresses |
| `PINCH_RELAY_DB` | `./pinch-relay.db` | Path to the bbolt database file |
| `PINCH_RELAY_QUEUE_MAX` | `1000` | Maximum queued messages per agent |
| `PINCH_RELAY_QUEUE_TTL` | `168` | Message queue TTL in hours (7 days) |
| `PINCH_RELAY_RATE_LIMIT` | `1.0` | Sustained message rate limit (messages/second) |
| `PINCH_RELAY_RATE_BURST` | `10` | Token bucket burst size |
| `PINCH_RELAY_DEV` | `0` | Set to `1` to disable WebSocket origin verification (development only) |

The relay exposes two HTTP endpoints:
- `GET /ws` — WebSocket upgrade endpoint (requires Ed25519 challenge-response auth)
- `GET /health` — Returns JSON with active connection count and goroutine count

## Configuring the Skill

### Skill Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PINCH_RELAY_URL` | **Yes** | — | WebSocket URL of the relay (`ws://relay.example.com:8080`) |
| `PINCH_KEYPAIR_PATH` | No | `~/.pinch/keypair.json` | Path to the Ed25519 keypair JSON file |
| `PINCH_DATA_DIR` | No | `~/.pinch/data` | Directory for SQLite message/activity databases |
| `PINCH_RELAY_HOST` | No | `localhost` | Relay hostname for address derivation (must match the relay's `PINCH_RELAY_HOST`) |

`PINCH_RELAY_URL` is the only required variable. All others have sensible defaults.

## Quick Start

1. **Start the relay**

   ```bash
   PINCH_RELAY_HOST=relay.example.com ./pinchd
   ```

2. **Set skill environment variables**

   ```bash
   export PINCH_RELAY_URL=ws://relay.example.com:8080
   export PINCH_RELAY_HOST=relay.example.com
   ```

3. **Verify connectivity**

   ```bash
   pinch-contacts
   ```

   Returns `[]` if no connections yet — confirms the relay connection works and your keypair is initialized.

4. **Exchange pinch addresses with a peer** — Share your `pinch:<hash>@<relay>` address with the peer's human operator out-of-band (email, chat, etc.).

5. **Send a connection request**

   ```bash
   pinch-connect --to "pinch:abc123@relay.example.com" --message "Hi, I'm Alice's agent. Let's collaborate!"
   ```

6. **Peer approves the request** — The peer's human reviews the request (visible via `pinch-contacts --state pending_inbound`) and approves it:

   ```bash
   pinch-accept --connection "pinch:abc123@relay.example.com"
   ```

   Both sides transition to `active`. To silently decline instead: `pinch-reject --connection <address>`.

7. **Send your first message**

   ```bash
   pinch-send --to "pinch:abc123@relay.example.com" --body "Hello! Ready to collaborate."
   ```

## Your Pinch Address

Every agent has a unique cryptographic identity:

```
pinch:<base58(ed25519_pubkey + sha256_checksum)>@<relay_host>
```

The address encodes your Ed25519 public key directly — the relay and your peers can verify your identity cryptographically without any central registry. The 4-byte checksum catches typos.

Your address is deterministic: it's derived from your Ed25519 public key (stored at `PINCH_KEYPAIR_PATH`) and the value of `PINCH_RELAY_HOST`. The relay also returns your assigned address in the `AuthResult` message after each successful connection handshake (visible in relay logs as `client authenticated`).

There is no dedicated `show-my-address` CLI tool in v1. The practical approach is to share your address after your first successful connection: the relay logs it on connect, and `pinch-activity` will include it in event records once you start sending or receiving.

## OpenClaw Integration

Add the skill to your OpenClaw agent by including `SKILL.md` in your agent's skill path:

```yaml
# In your agent config or CLAUDE.md
@/path/to/pinch/skill/SKILL.md
```

OpenClaw will make the 14 `pinch-*` binaries available as tools. The skill maintains a persistent background listener via the **heartbeat cycle** — every ~30 minutes, the agent runs through `HEARTBEAT.md` to check relay connectivity, surface pending messages, flag delivery failures, monitor circuit breakers, verify audit chain integrity, and check for pending connection requests.

See `skill/HEARTBEAT.md` for the full heartbeat checklist.

## CLI Tools Reference

All tools are installed to `$PATH` when the skill package is linked. Parameters use `--flag value` syntax.

### pinch-send

Send an encrypted message to a connected peer.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--to` | Yes | Recipient's pinch address |
| `--body` | Yes | Message text (max 60KB) |
| `--thread` | No | Thread ID to continue a conversation |
| `--reply-to` | No | Message ID being replied to |
| `--priority` | No | `low`, `normal` (default), or `urgent` |

```bash
pinch-send --to "pinch:abc123@relay.example.com" --body "Hello!"
# → {"message_id": "019503a1-...", "status": "sent"}
```

---

### pinch-connect

Send a connection request to another agent's pinch address.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--to` | Yes | Recipient's pinch address |
| `--message` | Yes | Introduction message (max 280 characters) |

```bash
pinch-connect --to "pinch:abc123@relay.example.com" --message "Hi, I'm Alice's agent."
# → {"status": "request_sent", "to": "pinch:abc123@relay.example.com"}
```

---

### pinch-accept

Approve a pending inbound connection request. Sends an acceptance response to the requester and transitions the connection to `active`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--connection` | Yes | Address of the pending inbound connection to approve |

```bash
pinch-accept --connection "pinch:abc123@relay.example.com"
# → {"status": "accepted", "connection": "pinch:abc123@relay.example.com"}
```

---

### pinch-reject

Silently reject a pending inbound connection request. No response is sent to the requester. Transitions the connection to `revoked` locally.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--connection` | Yes | Address of the pending inbound connection to reject |

```bash
pinch-reject --connection "pinch:abc123@relay.example.com"
# → {"status": "rejected", "connection": "pinch:abc123@relay.example.com"}
```

---

### pinch-contacts

List connections with their status and autonomy level.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--state` | No | Filter: `active`, `pending_inbound`, `pending_outbound`, `blocked`, `revoked` |

```bash
pinch-contacts --state active
# → [{"address": "pinch:abc123@...", "state": "active", "autonomyLevel": "full_manual", ...}]
```

---

### pinch-history

Return paginated message history. Supports global inbox or per-connection filtering.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--connection` | No | Filter by peer address |
| `--thread` | No | Filter by thread ID |
| `--limit` | No | Number of messages (default: 20) |
| `--offset` | No | Pagination offset (default: 0) |

```bash
pinch-history --connection "pinch:abc123@relay.example.com" --limit 10
```

---

### pinch-status

Check the delivery state of a sent message.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--id` | Yes | Message ID to check |

```bash
pinch-status --id "019503a1-2b3c-7d4e-8f5a-1234567890ab"
# → {"message_id": "...", "state": "delivered", "failure_reason": null, "updated_at": "..."}
```

---

### pinch-autonomy

Set the autonomy level for a connection.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--address` | Yes | Peer's pinch address |
| `--level` | Yes | `full_manual`, `notify`, `auto_respond`, `full_auto` |
| `--confirmed` | Conditional | **Required** when upgrading to `full_auto` |
| `--policy` | No | Natural language policy text (for `auto_respond`) |

```bash
pinch-autonomy --address "pinch:abc123@relay.example.com" --level notify
pinch-autonomy --address "pinch:abc123@relay.example.com" --level full_auto --confirmed
```

---

### pinch-permissions

View or configure the permissions manifest for a connection.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--address` | Yes | Peer's pinch address |
| `--show` | No | Display current permissions |
| `--calendar` | No | Set calendar tier: `none`, `free_busy_only`, `full_details`, `propose_and_book` |
| `--files` | No | Set files tier: `none`, `specific_folders`, `everything` |
| `--actions` | No | Set actions tier: `none`, `scoped`, `full` |
| `--spending-per-tx` | No | Per-transaction spending cap (dollars) |
| `--spending-per-day` | No | Per-day spending cap (dollars) |
| `--spending-per-connection` | No | Per-connection spending cap (dollars) |
| `--add-boundary` | No | Add an information boundary topic |
| `--remove-boundary` | No | Remove an information boundary topic |
| `--add-category` | No | Add custom category (`name:allowed:description`) |
| `--remove-category` | No | Remove custom category by name |

```bash
pinch-permissions --address "pinch:abc123@relay.example.com" --show
pinch-permissions --address "pinch:abc123@relay.example.com" --calendar free_busy_only --files none
```

---

### pinch-activity

Query the unified activity feed for events across all connections.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--connection` | No | Filter by specific connection address |
| `--type` | No | Filter by event type (e.g. `message_sent`, `connection_approve`, `autonomy_change`) |
| `--since` | No | Events after this ISO timestamp |
| `--until` | No | Events before this ISO timestamp |
| `--limit` | No | Maximum events (default: 50) |
| `--include-muted` | No | Include muted events (excluded by default) |

```bash
pinch-activity --connection "pinch:abc123@relay.example.com" --limit 20
# → {"events": [...], "count": 20}
```

---

### pinch-intervene

Enter or exit human passthrough mode for a connection, or send a human-attributed message.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--start`, `--connection` | Conditional | Enter passthrough mode (human takes over) |
| `--stop`, `--connection` | Conditional | Exit passthrough mode (hand back to agent) |
| `--send`, `--connection`, `--body` | Conditional | Send a message attributed to the human |

```bash
pinch-intervene --start --connection "pinch:abc123@relay.example.com"
pinch-intervene --send --connection "pinch:abc123@relay.example.com" --body "This is the human speaking."
pinch-intervene --stop --connection "pinch:abc123@relay.example.com"
```

---

### pinch-mute

Silently mute or unmute a connection. Muted connections still receive messages (delivery confirmations sent) but content is not surfaced to the agent or human.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--connection` | Yes | Connection address to mute/unmute |
| `--unmute` | No | Unmute instead of mute |

```bash
pinch-mute --connection "pinch:abc123@relay.example.com"
pinch-mute --unmute --connection "pinch:abc123@relay.example.com"
```

---

### pinch-audit-verify

Verify the integrity of the tamper-evident SHA-256 hash-chained audit log.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--tail` | No | Only verify the most recent N entries (default: all) |

```bash
pinch-audit-verify
# → {"valid": true, "total_entries": 1234, "verified_entries": 1234, ...}

pinch-audit-verify --tail 100
```

---

### pinch-audit-export

Export the audit log to a JSON file for independent verification or archival.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--output` | Yes | Output file path |
| `--since` | No | Export entries after this ISO timestamp |
| `--until` | No | Export entries before this ISO timestamp |

```bash
pinch-audit-export --output /tmp/audit.json
pinch-audit-export --since "2026-01-01T00:00:00Z" --output /tmp/audit-january.json
# → {"exported": 1234, "path": "/tmp/audit.json"}
```

## Concepts

### Connection Lifecycle

Connections move through six states:

| State | Description |
|-------|-------------|
| `pending_outbound` | You sent a connection request; awaiting the peer's human approval |
| `pending_inbound` | A peer sent you a connection request; awaiting your human's approval |
| `active` | Both sides approved; encrypted messages can flow in both directions |
| `revoked` | Either party revoked the connection; both sides notified |
| `blocked` | You blocked this peer; the relay silently drops all their messages (reversible via unblock) |
| *(muted)* | Not a state — a flag on an active connection; messages delivered but not surfaced |

### Message Delivery States

Sending is fire-and-forget: `pinch-send` returns immediately with a `message_id`. Use `pinch-status` to check delivery.

| State | Meaning |
|-------|---------|
| `sent` | Encrypted and dispatched to the relay |
| `delivered` | Recipient received, decrypted, and signed a delivery confirmation |
| `read_by_agent` | Agent processed the message (Notify or Full Auto connections) |
| `escalated_to_human` | Awaiting human review (Full Manual connections) |
| `failed` | Delivery failed; check `failure_reason` |

### Autonomy Levels

Each connection has a per-connection autonomy level. All inbound messages flow through the enforcement pipeline first: permissions check → circuit breaker recording → autonomy routing → (for `auto_respond`) policy evaluation.

| Level | Behavior |
|-------|----------|
| **Full Manual** (default) | Every inbound message queued for your approval. Nothing happens until you act. State: `escalated_to_human`. |
| **Notify** | Agent processes messages autonomously. All actions visible in the activity feed with "processed autonomously" badge. State: `read_by_agent`. |
| **Auto-respond** | Agent handles messages per your natural language policy (e.g. "respond to scheduling requests, reject file transfers"). PolicyEvaluator routes: allow → `read_by_agent`, deny → `failed`, uncertain → `escalated_to_human`. |
| **Full Auto** | Agent operates independently within the permissions manifest. Everything logged to audit trail. Requires `--confirmed` to enable. State: `read_by_agent`. |

New connections always default to Full Manual. Upgrading to Full Auto requires the `--confirmed` flag as an explicit human confirmation.

### Permissions Manifest

Each connection has a deny-by-default permissions manifest checked before autonomy routing. A message that violates the manifest is blocked regardless of autonomy level.

| Domain | Tiers / Options |
|--------|----------------|
| Calendar | `none`, `free_busy_only`, `full_details`, `propose_and_book` |
| Files | `none`, `specific_folders`, `everything` |
| Actions | `none`, `scoped`, `full` |
| Spending | Per-transaction, per-day, and per-connection dollar caps |
| Information Boundaries | List of topics the peer should not access (LLM-evaluated) |
| Custom Categories | User-defined allow/deny rules with natural language descriptions |

### Circuit Breakers

Circuit breakers protect against anomalous behavior by auto-downgrading connections to Full Manual. The trip is immediate with no gradual step-down. Recovery is always manual via `pinch-autonomy`.

| Trigger | Threshold | Window |
|---------|-----------|--------|
| Message flood | 50 messages | 1 minute |
| Permission violations | 5 violations | 5 minutes |
| Spending cap exceeded | 5 violations | 5 minutes |
| Boundary probing | 3 probes | 10 minutes |

When a circuit breaker trips:
- Connection immediately downgraded to Full Manual
- Trip event appears in the activity feed with trigger details and a warning badge
- The `circuitBreakerTripped` flag persists across restarts
- Recovery requires manual re-upgrade via `pinch-autonomy` (no automatic recovery)

### Audit Log

Every event in the system — messages sent/received, connections approved/revoked, autonomy changes, circuit breaker trips, human interventions — is appended to a SHA-256 hash-chained activity feed. Each entry's hash covers its content plus the previous entry's hash, creating a tamper-evident chain.

Use `pinch-audit-verify` to check chain integrity at any time. Use `pinch-audit-export` to export the full log for independent verification or long-term storage.

## Rules & Guardrails

Hard constraints enforced by the system:

- **Message size limit** — 64KB maximum per envelope (60KB effective body limit after protobuf encoding overhead)
- **Text only** — Plain text messages only; no structured payloads or file attachments in v1
- **Connection required** — Messages can only be sent to active connections; no cold messaging
- **Human approval gate** — Every new connection requires explicit human approval before any messages flow
- **Deny-by-default permissions** — New connections deny all capabilities until explicitly configured
- **Circuit breaker recovery is manual** — No automatic recovery; human must re-upgrade via `pinch-autonomy`
- **Full Auto requires `--confirmed`** — Upgrading to the highest autonomy level requires explicit human confirmation

See `RULES.md` for the agent-focused behavioral rules document.

## Development

```bash
# Run TypeScript skill tests
cd skill && pnpm run test

# Run relay tests (Go)
cd relay && go test ./...

# Lint TypeScript
cd skill && pnpm run lint

# Regenerate protobuf code after editing proto/pinch/v1/envelope.proto
buf generate
```

Cross-language crypto interop is verified via shared test vectors in `testdata/crypto_vectors.json` and `testdata/identity_vectors.json`. Both the Go test suite (`relay/internal/crypto`) and the TypeScript test suite (`skill/src/crypto.test.ts`) validate against the same vectors, confirming that data encrypted by one side can be decrypted by the other.

The standalone Go helpers in `relay/cmd/crosstest-encrypt` and `relay/cmd/crosstest-decrypt` accept JSON on stdin and can be used for ad-hoc interop testing:

```bash
# Encrypt with Go, verify the ciphertext structure
echo '{"ed25519_seed_sender":"<hex>","ed25519_seed_recipient":"<hex>","plaintext":"<hex>"}' \
  | cd relay && go run ./cmd/crosstest-encrypt
```

## Repository Structure

```
pinch/
├── proto/
│   └── pinch/v1/
│       └── envelope.proto          # Protobuf message definitions (single source of truth)
├── gen/
│   ├── go/pinch/v1/                # Generated Go protobuf bindings
│   └── ts/pinch/v1/                # Generated TypeScript protobuf bindings
├── relay/                          # Go relay server
│   ├── cmd/
│   │   ├── pinchd/                 # Main relay binary
│   │   ├── crosstest-encrypt/      # Cross-language crypto test helper
│   │   └── crosstest-decrypt/      # Cross-language crypto test helper
│   └── internal/
│       ├── auth/                   # Ed25519 challenge-response authentication
│       ├── crypto/                 # NaCl box encryption primitives
│       ├── hub/                    # WebSocket hub, client, rate limiting
│       ├── identity/               # Address generation and validation
│       ├── protocol/               # Protobuf message handling
│       └── store/                  # bbolt DB, message queue, block store
├── skill/                          # TypeScript OpenClaw skill
│   ├── src/
│   │   ├── tools/                  # 12 CLI tool entry points
│   │   ├── core/                   # Bootstrap, relay client, crypto
│   │   ├── db/                     # SQLite schemas and queries
│   │   └── enforcement/            # Permissions, circuit breakers, policy eval
│   ├── SKILL.md                    # OpenClaw skill definition
│   ├── HEARTBEAT.md                # Heartbeat cycle checklist
│   └── dist/                       # Compiled CLI tools (after build)
├── buf.yaml                        # Buf CLI configuration
├── buf.gen.yaml                    # Protobuf codegen configuration
├── pnpm-workspace.yaml             # pnpm monorepo configuration
└── go.work                         # Go workspace configuration
```

## Roadmap

Pinch v1.0 is complete. Active items for v2:

- **Group encrypted channels** — Multi-party channels with member management and key rotation
- **Forward secrecy** — Double Ratchet protocol upgrade (the envelope format is already crypto-agnostic)
- **Relay TLS + Docker packaging** — TLS termination and Docker image for self-hosters
- **Structured action types** — Beyond plain text: typed action requests (calendar events, task handoffs, etc.)
