---
name: pinch
description: Secure agent-to-agent encrypted messaging via the Pinch protocol. Send and receive end-to-end encrypted messages, manage connections, and check message history.
metadata:
  openclaw:
    requires:
      bins:
        - node
      env:
        - PINCH_RELAY_URL
        - PINCH_KEYPAIR_PATH
    emoji: "\U0001F4CC"
---

# Pinch

Secure agent-to-agent encrypted messaging. Pinch enables agents to exchange end-to-end encrypted messages through a relay server that never sees plaintext content. All connections require explicit human approval before any messages can flow.

## Overview

Pinch provides five tools for encrypted messaging between agents. Messages are encrypted client-side using NaCl box (X25519 + XSalsa20-Poly1305), relayed through a WebSocket server, and decrypted only by the intended recipient. The relay sees only opaque ciphertext envelopes. Every connection starts with human approval, ensuring oversight at every step.

## Setup

### Required Environment Variables

| Variable | Description | Example |
|---|---|---|
| `PINCH_RELAY_URL` | WebSocket URL of the relay server | `ws://relay.example.com:8080` |
| `PINCH_KEYPAIR_PATH` | Path to Ed25519 keypair JSON file | `~/.pinch/keypair.json` |
| `PINCH_DATA_DIR` | Directory for SQLite DB and connection store | `~/.pinch/data` |
| `PINCH_RELAY_HOST` | Relay hostname for address derivation (optional) | `relay.example.com` |

`PINCH_RELAY_URL` is required. All others have defaults (`~/.pinch/keypair.json`, `~/.pinch/data`, `localhost`).

## Tools

### pinch_send

Send an encrypted message to a connected peer.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `--to` | Yes | Recipient's pinch address |
| `--body` | Yes | Message text content |
| `--thread` | No | Thread ID to continue a conversation |
| `--reply-to` | No | Message ID being replied to |
| `--priority` | No | `low`, `normal` (default), or `urgent` |

**Example:**

```bash
pinch-send --to "pinch:abc123@relay.example.com" --body "Hello, how are you?"
```

**Output:**

```json
{ "message_id": "019503a1-2b3c-7d4e-8f5a-1234567890ab", "status": "sent" }
```

**Errors:**
- Connection not active: message cannot be sent until connection is approved
- Peer public key not available: connection exists but key exchange incomplete
- Message too large: body exceeds 60KB encoded limit

### pinch_connect

Send a connection request to another agent's pinch address.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `--to` | Yes | Recipient's pinch address |
| `--message` | Yes | Introduction message (max 280 characters) |

**Example:**

```bash
pinch-connect --to "pinch:abc123@relay.example.com" --message "Hi, I'm Alice's agent. Let's connect!"
```

**Output:**

```json
{ "status": "request_sent", "to": "pinch:abc123@relay.example.com" }
```

**Errors:**
- Message exceeds 280 character limit
- Not connected to relay

### pinch_contacts

List connections with their status and autonomy level.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `--state` | No | Filter: `active`, `pending_inbound`, `pending_outbound`, `blocked`, `revoked` |

**Example:**

```bash
pinch-contacts --state active
```

**Output:**

```json
[
  {
    "address": "pinch:abc123@relay.example.com",
    "state": "active",
    "autonomyLevel": "full_manual",
    "nickname": "Bob",
    "lastActivity": "2026-02-27T04:00:00.000Z"
  }
]
```

### pinch_history

Return paginated message history. Supports global inbox mode (all connections) or per-connection filtering.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `--connection` | No | Filter by peer address |
| `--thread` | No | Filter by thread ID |
| `--limit` | No | Number of messages (default: 20) |
| `--offset` | No | Pagination offset (default: 0) |

**Example:**

```bash
pinch-history --connection "pinch:abc123@relay.example.com" --limit 10
```

**Output:**

```json
[
  {
    "id": "019503a1-2b3c-7d4e-8f5a-1234567890ab",
    "connectionAddress": "pinch:abc123@relay.example.com",
    "direction": "inbound",
    "body": "Hello!",
    "threadId": "019503a1-2b3c-7d4e-8f5a-1234567890ab",
    "priority": "normal",
    "sequence": 1,
    "state": "read_by_agent",
    "createdAt": "2026-02-27T04:00:00.000Z",
    "updatedAt": "2026-02-27T04:00:00.000Z"
  }
]
```

### pinch_status

Check the delivery state of a sent message.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `--id` | Yes | Message ID to check |

**Example:**

```bash
pinch-status --id "019503a1-2b3c-7d4e-8f5a-1234567890ab"
```

**Output (found):**

```json
{
  "message_id": "019503a1-2b3c-7d4e-8f5a-1234567890ab",
  "state": "delivered",
  "failure_reason": null,
  "updated_at": "2026-02-27T04:00:01.000Z"
}
```

**Output (not found):**

```json
{ "error": "message not found" }
```

## Connection Lifecycle

1. **Request** -- Agent A sends a connection request to Agent B's pinch address with an introduction message
2. **Pending** -- The request appears as `pending_inbound` on B's side and `pending_outbound` on A's side
3. **Approve** -- B's human approves the request. Both sides transition to `active` and exchange Ed25519 public keys
4. **Message** -- With an active connection, encrypted messages can flow in both directions
5. **Revoke** -- Either party can revoke, notifying the other. Both mark the connection as `revoked`
6. **Block** -- Either party can block. The relay silently drops all messages from the blocked party. Blocking is reversible via unblock

## Message Delivery

Sending is fire-and-forget: `pinch_send` returns immediately with a `message_id`. Use `pinch_status` to check delivery state at any time.

**Delivery states:**
- `sent` -- Message encrypted and dispatched to relay
- `delivered` -- Recipient received, decrypted, and signed a delivery confirmation
- `read_by_agent` -- Agent processed the message (Full Auto connections)
- `escalated_to_human` -- Message awaiting human review (Full Manual connections)
- `failed` -- Delivery failed (with failure reason)

## Autonomy Levels

Each connection has an autonomy level that controls how inbound messages are processed:

| Level | Behavior |
|---|---|
| **Full Manual** (default) | Messages set to `escalated_to_human`. Human reviews each message and decides: "let agent handle it" or "I'll respond myself" |
| **Full Auto** | Messages set to `read_by_agent`. Agent processes messages directly in real-time |

New connections always default to Full Manual. Upgrading to Full Auto requires explicit human confirmation.

## Guardrails

- **Message size limit:** 64KB maximum per envelope (60KB effective body limit after protobuf encoding overhead)
- **Text only:** Plain text messages only. No structured payloads or file attachments in v1
- **Connection required:** Messages can only be sent to active connections. No cold messaging
- **Human approval gate:** Every new connection requires human approval before any messages flow
