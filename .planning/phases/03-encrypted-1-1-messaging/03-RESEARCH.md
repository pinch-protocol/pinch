# Phase 3: Encrypted 1:1 Messaging - Research

**Researched:** 2026-02-26
**Domain:** E2E encrypted messaging, delivery confirmations, local message persistence, OpenClaw skill integration
**Confidence:** HIGH

## Summary

Phase 3 builds the actual messaging layer on top of the Phase 1/2 foundation. The crypto primitives (NaCl box, Ed25519-to-X25519 key conversion) already exist and are cross-language tested. The relay already routes binary envelopes between authenticated agents via WebSocket. The protobuf schema already defines `MESSAGE_TYPE_MESSAGE`, `MESSAGE_TYPE_DELIVERY_CONFIRM`, `EncryptedPayload`, and `PlaintextPayload` message types. The connection store already tracks peer public keys, connection states, and autonomy levels. The work is: (1) wire up encryption/decryption into actual message send/receive flows, (2) add delivery confirmation signing and verification, (3) build a local message store for history and state tracking, (4) create the five OpenClaw skill tools (`pinch_send`, `pinch_connect`, `pinch_contacts`, `pinch_history`, `pinch_status`), (5) write the SKILL.md with proper frontmatter, and (6) route inbound messages based on connection autonomy level (Full Manual vs Full Auto).

No new cryptographic dependencies are needed. The existing `libsodium-wrappers-sumo` (TypeScript) and `golang.org/x/crypto/nacl/box` (Go) handle all encryption. The existing `ws` package handles WebSocket connections. The primary new dependency recommendation is `better-sqlite3` for the local message store, replacing the simpler JSON file approach used for connection state -- message volumes will grow fast, and SQLite handles concurrent reads, indexed queries, and pagination far better than JSON serialization.

**Primary recommendation:** Use the existing crypto stack (no new dependencies for encryption), add `better-sqlite3` for the local message store, build five tool modules as plain TypeScript functions that the SKILL.md instructions reference, and implement a `MessageManager` class that coordinates encryption/decryption/storage/delivery-confirmation alongside the existing `ConnectionManager`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Five tools: `pinch_send`, `pinch_connect`, `pinch_contacts`, `pinch_history`, `pinch_status`
- `pinch_send` -- core params: recipient (pinch address), body (text). Optional: thread_id, reply_to (message_id), priority (low/normal/urgent)
- `pinch_connect` -- send connection requests to a pinch address. Lifecycle tool for requesting new connections
- `pinch_contacts` -- list and query existing connections (status, autonomy level, labels)
- `pinch_history` -- two modes: per-connection (filter by connection + optional thread_id) and global inbox (across all connections). Paginated
- `pinch_status` -- check delivery state of a sent message by message_id
- Returns immediately with message_id on send (fire-and-forget)
- Text only -- plain text messages, no structured payloads or attachments in v1
- 64KB message size limit enforced at relay level
- Full context envelope accompanies each message: sender address, timestamp, connection name/label, thread_id, reply_to, priority, sequence number
- Messages persisted locally on the agent side (disk storage) -- survives restarts, powers pinch_history
- Always automatic delivery confirmations -- every delivered message triggers a signed confirmation
- Fire-and-forget sending: pinch_send returns instantly with message_id, agent checks via pinch_status when needed
- Six delivery states: Sent -> Relayed -> Delivered -> Read-by-agent -> Escalated-to-human, plus Failed (with reason)
- 30-second relay buffer for transient disconnects before marking as failed (Phase 4 adds real store-and-forward)
- Full Manual: messages appear as pending items in the OpenClaw activity feed for human review
- Human approves each message and chooses per-message: "let agent handle it" or "I'll respond myself"
- Full Auto: messages pushed to agent in real-time via persistent WebSocket (not heartbeat polling)
- Agent decides whether to reply -- message is presented to LLM with full context, agent has pinch_send available but no forced acknowledgment

### Claude's Discretion
- SKILL.md YAML frontmatter structure and markdown body layout
- Exact WebSocket heartbeat/reconnection strategy
- Local message store format (JSON file, SQLite, etc.)
- Error message wording and error code taxonomy
- Exact protobuf message schema for encrypted payloads
- How thread_id is generated (UUID, human-readable, etc.)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CRYP-01 | Agent encrypts 1:1 messages using NaCl box (X25519 key exchange + XSalsa20-Poly1305) | Existing `crypto.ts` encrypt/decrypt functions handle NaCl box. Existing `EncryptedPayload` and `PlaintextPayload` protobuf messages define the wire format. MessageManager wraps these into a send flow: serialize PlaintextPayload -> encrypt -> wrap in EncryptedPayload -> wrap in Envelope -> send |
| CRYP-05 | Sender receives E2E signed delivery confirmation when message is delivered to recipient | Recipient signs `message_id + timestamp` with Ed25519 private key using `crypto_sign_detached`, wraps in a `DELIVERY_CONFIRM` envelope. Sender verifies with recipient's public key using `crypto_sign_verify_detached`. Both functions available in libsodium |
| RELY-04 | Relay delivers messages in real-time when both agents are online (sub-100ms relay hop) | Relay hub.RouteMessage already looks up recipient by address and calls client.Send (non-blocking channel write). No relay-side changes needed for basic delivery. 64KB relay-level enforcement needs a size check in RouteMessage |
| SKIL-01 | OpenClaw SKILL.md definition with YAML frontmatter and markdown body | Research covers SKILL.md format: name, description, metadata.openclaw frontmatter fields. Body contains instructions, tool descriptions, workflow steps |
| SKIL-02 | Persistent background listener maintains WebSocket connection via OpenClaw heartbeat cycle | RelayClient already maintains persistent WebSocket with heartbeat. HEARTBEAT.md checklist checks connection status and surfaces pending inbound messages. Reconnection with exponential backoff needed |
| SKIL-03 | Outbound tools follow standard OpenClaw skill patterns (pinch_send, pinch_connect, pinch_history, etc.) | Skills are instruction-based: SKILL.md describes tools as shell commands or scripts the agent invokes. Five tools map to TypeScript CLI entry points or shell scripts in the skill directory |
| SKIL-04 | Skill processes inbound messages/requests and routes based on autonomy level | Full Manual: queue message in local store with "pending_human_review" state, surface in HEARTBEAT.md. Full Auto: decrypt immediately, present to agent with full context. ConnectionStore.autonomyLevel already tracks per-connection setting |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| libsodium-wrappers-sumo | 0.8.0 | NaCl box encryption, Ed25519 signing for delivery confirmations | Already in use since Phase 1. Provides `crypto_box_easy`, `crypto_sign_detached`, `crypto_sign_verify_detached` |
| @bufbuild/protobuf | ^2.11.0 | Protobuf serialization for PlaintextPayload and Envelope | Already in use since Phase 1. PlaintextPayload and EncryptedPayload schemas already defined |
| ws | ^8.19.0 | WebSocket client for relay connection | Already in use since Phase 1. RelayClient wraps this |
| better-sqlite3 | ^11.8.0 | Local message store (SQLite) for message persistence and history queries | Synchronous API, fastest Node.js SQLite binding, handles pagination and indexed queries. Replaces JSON file for message data |
| @types/better-sqlite3 | ^7.6.13 | TypeScript types for better-sqlite3 | Dev dependency for type safety |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| uuid | ^11.0.0 | Generate UUIDv7 message IDs and thread IDs | Time-ordered UUIDs for message_id (sortable by creation time) and thread_id generation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| better-sqlite3 | JSON file (lowdb) | JSON works for small datasets but degrades with thousands of messages; no indexed queries, no pagination support, full-file rewrite on every save. SQLite handles all these natively |
| better-sqlite3 | Node.js built-in node:sqlite (experimental) | Available in Node 22+ but marked experimental and API is unstable. better-sqlite3 is battle-tested |
| uuid (UUIDv7) | crypto.randomUUID() (UUIDv4) | UUIDv4 is random and not time-sortable. UUIDv7 encodes timestamp, enabling natural chronological ordering without a separate index column. Critical for message history |

**Installation:**
```bash
cd skill && pnpm add better-sqlite3 uuid && pnpm add -D @types/better-sqlite3
```

## Architecture Patterns

### Recommended Project Structure
```
skill/src/
  crypto.ts              # [existing] NaCl box encrypt/decrypt, key conversion
  identity.ts            # [existing] Keypair generation, address derivation
  auth.ts                # [existing] Challenge signing
  relay-client.ts        # [existing] WebSocket connection + auth handshake
  connection-store.ts    # [existing] JSON-backed connection persistence
  connection.ts          # [existing] ConnectionManager lifecycle
  message-store.ts       # [NEW] SQLite-backed message persistence
  message-manager.ts     # [NEW] Encrypt/decrypt/send/receive/confirm orchestration
  delivery.ts            # [NEW] Delivery confirmation signing and verification
  inbound-router.ts      # [NEW] Routes inbound messages based on autonomy level
  tools/                 # [NEW] OpenClaw tool implementations
    pinch-send.ts        # pinch_send tool
    pinch-connect.ts     # pinch_connect tool (wraps ConnectionManager)
    pinch-contacts.ts    # pinch_contacts tool (wraps ConnectionStore)
    pinch-history.ts     # pinch_history tool (wraps MessageStore)
    pinch-status.ts      # pinch_status tool (wraps MessageStore)
  index.ts               # [existing] Version export, expand to main entry point
skill/
  SKILL.md               # [NEW] OpenClaw skill definition
  HEARTBEAT.md           # [NEW] Heartbeat checklist for persistent listener
```

### Pattern 1: MessageManager -- Encryption Orchestration
**What:** Central class coordinating message send/receive with encryption, storage, and delivery confirmation.
**When to use:** All message operations flow through this single coordinator.
**Example:**
```typescript
// Sending flow:
// 1. Validate connection is active and has peer public key
// 2. Look up peer's X25519 public key (convert from stored Ed25519)
// 3. Build PlaintextPayload protobuf (text, sequence, timestamp)
// 4. Serialize PlaintextPayload to bytes
// 5. Encrypt with NaCl box (sender X25519 priv + recipient X25519 pub)
// 6. Build EncryptedPayload protobuf (nonce, ciphertext, sender_public_key)
// 7. Build Envelope with MESSAGE type, message_id, addresses
// 8. Store outbound message in MessageStore with state "sent"
// 9. Send via RelayClient.sendEnvelope()
// 10. Return message_id immediately

class MessageManager {
  constructor(
    private relayClient: RelayClient,
    private connectionStore: ConnectionStore,
    private messageStore: MessageStore,
    private keypair: Keypair,
  ) {}

  async sendMessage(params: {
    recipient: string;
    body: string;
    threadId?: string;
    replyTo?: string;
    priority?: 'low' | 'normal' | 'urgent';
  }): Promise<string> {
    // Returns message_id (UUIDv7)
  }

  async handleIncomingMessage(envelope: Envelope): Promise<void> {
    // Decrypt, store, route based on autonomy level
  }

  async handleDeliveryConfirmation(envelope: Envelope): Promise<void> {
    // Verify signature, update message state
  }
}
```

### Pattern 2: Delivery Confirmation -- E2E Signed Receipts
**What:** Recipient signs a delivery confirmation with Ed25519 to prove receipt. The signature covers `message_id + timestamp` so neither the relay nor a third party can forge confirmations.
**When to use:** Automatically on every received message.
**Example:**
```typescript
// On receiving a message:
// 1. Decrypt the message
// 2. Store in local MessageStore
// 3. Sign confirmation: crypto_sign_detached(message_id || timestamp, privateKey)
// 4. Build DeliveryConfirm envelope with signature, message_id, timestamp
// 5. Send back to sender via relay

// On receiving a confirmation:
// 1. Extract message_id from confirmation
// 2. Look up original message in store
// 3. Get sender's Ed25519 public key from connection store
// 4. Verify: crypto_sign_verify_detached(signature, message_id || timestamp, senderPubKey)
// 5. Update message state to "delivered"
```

### Pattern 3: Inbound Message Routing by Autonomy Level
**What:** Incoming decrypted messages are routed differently based on the connection's autonomy level.
**When to use:** On every inbound message after decryption.
**Example:**
```typescript
// Full Manual routing:
// 1. Store message with state "pending_human_review"
// 2. Write entry to HEARTBEAT.md or activity feed queue
// 3. On next heartbeat, agent surfaces: "Pending message from X: [preview]"
// 4. Human approves -> state changes to "approved", either:
//    a. "let agent handle it" -> present to LLM
//    b. "I'll respond" -> human drafts reply via pinch_send

// Full Auto routing:
// 1. Store message with state "delivered"
// 2. Present to LLM immediately with full context:
//    - Sender address, nickname, connection label
//    - Thread history (if thread_id present)
//    - Priority level
//    - Message body
// 3. Agent decides whether to reply (pinch_send available, no forced response)
```

### Pattern 4: Message Store -- SQLite Schema
**What:** SQLite database for local message persistence with indexed queries.
**When to use:** All message read/write operations.
**Example:**
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,              -- UUIDv7 message_id
  connection_address TEXT NOT NULL,  -- peer's pinch: address
  direction TEXT NOT NULL,           -- 'inbound' | 'outbound'
  body TEXT NOT NULL,                -- plaintext message content
  thread_id TEXT,                    -- optional thread grouping
  reply_to TEXT,                     -- optional parent message_id
  priority TEXT DEFAULT 'normal',    -- 'low' | 'normal' | 'urgent'
  sequence INTEGER NOT NULL,         -- monotonic per-connection
  state TEXT NOT NULL,               -- delivery state (see below)
  failure_reason TEXT,               -- populated when state = 'failed'
  created_at TEXT NOT NULL,          -- ISO timestamp
  updated_at TEXT NOT NULL           -- ISO timestamp
);

CREATE INDEX idx_messages_connection ON messages(connection_address, created_at);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_messages_state ON messages(state);
CREATE INDEX idx_messages_direction_state ON messages(direction, state);

-- Delivery states for outbound:
--   'sent' -> 'relayed' -> 'delivered' -> 'read_by_agent' -> 'escalated_to_human'
--   'sent' -> 'failed' (with failure_reason)
-- States for inbound:
--   'received' -> 'pending_human_review' (Full Manual) OR 'delivered' (Full Auto)
--   'pending_human_review' -> 'approved' -> 'read_by_agent'

-- Per-connection sequence counter
CREATE TABLE sequences (
  connection_address TEXT PRIMARY KEY,
  next_sequence INTEGER NOT NULL DEFAULT 1
);
```

### Pattern 5: SKILL.md Structure for OpenClaw
**What:** SKILL.md with YAML frontmatter defining the Pinch skill and markdown body with tool instructions.
**When to use:** Required by OpenClaw for skill registration.
**Example:**
```yaml
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
```

The markdown body describes when to use each tool, parameter formats, example invocations, guardrails, and failure handling. Tools are implemented as shell scripts or TypeScript entry points that the agent invokes via the `exec` tool.

### Anti-Patterns to Avoid
- **Polling for delivery confirmations:** Do NOT poll the relay or use timers for delivery state. Confirmations arrive as WebSocket messages and update the store reactively. `pinch_status` reads from the local store, not the relay.
- **Blocking on send:** Do NOT wait for delivery confirmation before returning from `pinch_send`. Return message_id immediately (fire-and-forget). The confirmation arrives asynchronously and updates the store.
- **Storing raw ciphertext locally:** Do NOT persist the encrypted bytes. After decryption, store only the plaintext in the local SQLite database. The ciphertext is ephemeral and only exists during transit through the relay.
- **Re-encrypting for storage:** Do NOT re-encrypt messages for local storage. The local SQLite database is on the agent's own machine. Encryption at rest is the OS/filesystem's responsibility, not the application's.
- **Single envelope handler:** Do NOT put all message type handling in one giant switch statement. Use separate handler functions (MessageManager for MESSAGE/DELIVERY_CONFIRM, ConnectionManager for CONNECTION_*, etc.) registered on the RelayClient.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Message ID generation | Custom ID scheme with counters | `uuid` v7 (time-ordered) | UUIDv7 encodes timestamp, is globally unique, sortable, and widely understood. Custom schemes need collision handling |
| SQLite database access | Raw `fs` reads/writes with JSON | `better-sqlite3` | Handles concurrent access, transactions, indexed queries, pagination. JSON files lock on write and degrade with size |
| Protobuf serialization | Custom binary format for encrypted payloads | `@bufbuild/protobuf` with existing schemas | PlaintextPayload and EncryptedPayload already defined in proto. Cross-language compatibility guaranteed by buf codegen |
| WebSocket reconnection | Custom timer loops | Exponential backoff with jitter function in RelayClient | Standard pattern: `min(base * 2^attempt + jitter, maxDelay)`. Hand-rolled reconnection misses edge cases (simultaneous reconnects, thundering herd) |
| Ed25519 signing | Custom signing scheme for confirmations | `libsodium-wrappers-sumo` `crypto_sign_detached` / `crypto_sign_verify_detached` | Already used in auth module. Detached signatures are the standard for signing arbitrary data without wrapping it |

**Key insight:** Phase 3 adds no new cryptographic operations beyond what Phase 1 established. The NaCl box encrypt/decrypt, Ed25519 signing, and key conversion functions are all already implemented and cross-language tested. The work is pure wiring: compose existing primitives into message flows.

## Common Pitfalls

### Pitfall 1: Public Key Availability for Encryption
**What goes wrong:** Agent tries to encrypt a message to a peer but the peer's public key isn't available in the connection store. This happens when the connection was established before Phase 3 (in testing), or when the key exchange during connection approval didn't persist the peer's Ed25519 public key.
**Why it happens:** Phase 2's ConnectionManager stores `peerPublicKey` as a base64 string, but during connection request/approve, the sender_public_key and responder_public_key fields are sent as empty `Uint8Array(0)` with comments noting "Pubkey exchange via auth; relay verifies identity." The public keys are known to the relay but not exchanged between agents in the connection flow.
**How to avoid:** During connection approval, both parties MUST include their Ed25519 public key in the ConnectionRequest/ConnectionResponse. The receiving agent stores this in `peerPublicKey`. This is a Phase 2 gap that Phase 3 must fix: populate `sender_public_key` in ConnectionRequest and `responder_public_key` in ConnectionResponse with actual key bytes. Alternatively, extract the public key from the pinch address (it's embedded in the base58 payload per `identity.ts` validateAddress).
**Warning signs:** `peerPublicKey` is empty string or empty bytes in the connection store after approval.

### Pitfall 2: Sequence Number Monotonicity
**What goes wrong:** Sequence numbers in PlaintextPayload are not strictly monotonic per-connection, enabling replay attacks or message reordering confusion.
**Why it happens:** If the sequence counter is stored in memory only, it resets on process restart. If stored in the JSON connection store, concurrent sends could race.
**How to avoid:** Store sequence counters in the SQLite message store (separate `sequences` table with per-connection atomic increment). Use a SQL transaction: `UPDATE sequences SET next_sequence = next_sequence + 1 WHERE connection_address = ? RETURNING next_sequence`. SQLite serializes writes, preventing races.
**Warning signs:** Duplicate sequence numbers in message history, or gaps that don't correspond to failed sends.

### Pitfall 3: Key Conversion Timing
**What goes wrong:** Calling `ed25519PubToX25519` or `ed25519PrivToX25519` before `ensureSodiumReady()` throws or returns garbage.
**Why it happens:** libsodium WASM module loads asynchronously. The `ensureSodiumReady()` guard is easy to forget when adding new code paths.
**How to avoid:** The MessageManager constructor or init method must call `ensureSodiumReady()` before any crypto operations. Convert keys once during initialization and cache the X25519 versions rather than converting on every send/receive.
**Warning signs:** Intermittent crypto failures on first message send, especially in tests.

### Pitfall 4: Delivery Confirmation Forgery
**What goes wrong:** An attacker or misbehaving relay sends a fake delivery confirmation to trick the sender into thinking a message was delivered.
**Why it happens:** If the confirmation is not cryptographically signed by the recipient, anyone who knows the message_id can forge one.
**How to avoid:** CRYP-05 requires E2E signed confirmations. The recipient signs `message_id || timestamp` with their Ed25519 private key. The sender verifies the signature using the recipient's Ed25519 public key (from the connection store). The relay sees only the signed envelope and cannot forge a valid signature.
**Warning signs:** Delivery confirmations arriving for messages sent to offline agents (before Phase 4's store-and-forward).

### Pitfall 5: 64KB Size Limit Enforcement Location
**What goes wrong:** Message size is checked after encryption, but the encrypted payload (with nonce, protobuf overhead, and Poly1305 MAC) is larger than the plaintext. A 64KB plaintext could produce a >64KB encrypted envelope.
**Why it happens:** NaCl box adds 16 bytes (Poly1305 MAC) + 24 bytes (nonce), plus protobuf field overhead.
**How to avoid:** Enforce the 64KB limit on the final serialized Envelope bytes, not on the plaintext. Check at the relay in RouteMessage (as the authoritative enforcer) and also check client-side before sending (as a fast-fail optimization). The client-side check should use a conservative estimate (e.g., reject plaintext > 60KB to leave room for overhead).
**Warning signs:** Relay silently dropping messages near the size boundary.

### Pitfall 6: Heartbeat vs WebSocket Confusion
**What goes wrong:** Confusing OpenClaw's HEARTBEAT.md (periodic agent check-in at ~30min intervals) with the WebSocket ping/pong heartbeat (25-second interval for connection liveness). These are completely different systems.
**Why it happens:** Both use the word "heartbeat" but serve different purposes.
**How to avoid:** Use "ping/pong" or "keepalive" for the WebSocket liveness check (already implemented in RelayClient). Use "heartbeat" exclusively for the OpenClaw periodic agent turn. The HEARTBEAT.md file is read by the agent on each heartbeat cycle and is the mechanism for surfacing pending inbound messages in Full Manual mode.
**Warning signs:** Trying to deliver messages through HEARTBEAT.md in Full Auto mode (should use the real-time WebSocket channel instead).

## Code Examples

Verified patterns from existing codebase and official documentation:

### Encrypting and Sending a Message
```typescript
// Source: Composition of existing crypto.ts + relay-client.ts + protobuf patterns
import { create, toBinary } from "@bufbuild/protobuf";
import {
  EnvelopeSchema, EncryptedPayloadSchema, PlaintextPayloadSchema,
  MessageType,
} from "@pinch/proto/pinch/v1/envelope_pb.js";
import { encrypt, ed25519PubToX25519, ed25519PrivToX25519 } from "./crypto.js";
import { v7 as uuidv7 } from "uuid";

function buildEncryptedMessage(
  body: string,
  sequence: bigint,
  senderKeypair: Keypair,
  recipientEd25519Pub: Uint8Array,
  senderAddress: string,
  recipientAddress: string,
  opts?: { threadId?: string; replyTo?: string; priority?: string },
): { envelope: Uint8Array; messageId: string } {
  const messageId = uuidv7();

  // Build plaintext payload (inside encryption boundary)
  const plaintext = create(PlaintextPayloadSchema, {
    version: 1,
    sequence,
    timestamp: BigInt(Date.now()),
    content: new TextEncoder().encode(body),
    contentType: "text/plain",
  });
  const plaintextBytes = toBinary(PlaintextPayloadSchema, plaintext);

  // Convert keys to X25519 for NaCl box
  const senderX25519Priv = ed25519PrivToX25519(senderKeypair.privateKey);
  const recipientX25519Pub = ed25519PubToX25519(recipientEd25519Pub);

  // Encrypt (nonce + ciphertext returned)
  const sealed = encrypt(plaintextBytes, recipientX25519Pub, senderX25519Priv);
  const nonce = sealed.slice(0, 24);
  const ciphertext = sealed.slice(24);

  // Build envelope
  const envelope = create(EnvelopeSchema, {
    version: 1,
    fromAddress: senderAddress,
    toAddress: recipientAddress,
    type: MessageType.MESSAGE,
    messageId: new TextEncoder().encode(messageId),
    timestamp: BigInt(Date.now()),
    payload: {
      case: "encrypted",
      value: create(EncryptedPayloadSchema, {
        nonce,
        ciphertext,
        senderPublicKey: senderKeypair.publicKey,
      }),
    },
  });

  return { envelope: toBinary(EnvelopeSchema, envelope), messageId };
}
```

### Signing a Delivery Confirmation
```typescript
// Source: libsodium crypto_sign_detached pattern
import sodium from "libsodium-wrappers-sumo";
import { ensureSodiumReady } from "./crypto.js";

async function signDeliveryConfirmation(
  messageId: Uint8Array,
  timestamp: bigint,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureSodiumReady();
  // Concatenate message_id + timestamp bytes for signing
  const timestampBytes = new ArrayBuffer(8);
  new DataView(timestampBytes).setBigInt64(0, timestamp);
  const payload = new Uint8Array(messageId.length + 8);
  payload.set(messageId);
  payload.set(new Uint8Array(timestampBytes), messageId.length);
  return sodium.crypto_sign_detached(payload, privateKey);
}

async function verifyDeliveryConfirmation(
  signature: Uint8Array,
  messageId: Uint8Array,
  timestamp: bigint,
  senderPublicKey: Uint8Array,
): Promise<boolean> {
  await ensureSodiumReady();
  const timestampBytes = new ArrayBuffer(8);
  new DataView(timestampBytes).setBigInt64(0, timestamp);
  const payload = new Uint8Array(messageId.length + 8);
  payload.set(messageId);
  payload.set(new Uint8Array(timestampBytes), messageId.length);
  return sodium.crypto_sign_verify_detached(signature, payload, senderPublicKey);
}
```

### SQLite Message Store Setup
```typescript
// Source: better-sqlite3 documented patterns
import Database from "better-sqlite3";

function initMessageStore(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // Write-Ahead Logging for concurrent reads
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      connection_address TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      body TEXT NOT NULL,
      thread_id TEXT,
      reply_to TEXT,
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'urgent')),
      sequence INTEGER NOT NULL,
      state TEXT NOT NULL,
      failure_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_connection
      ON messages(connection_address, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);

    CREATE TABLE IF NOT EXISTS sequences (
      connection_address TEXT PRIMARY KEY,
      next_sequence INTEGER NOT NULL DEFAULT 1
    );
  `);

  return db;
}
```

### WebSocket Reconnection with Exponential Backoff
```typescript
// Source: Standard exponential backoff pattern
// This extends the existing RelayClient which currently has no reconnection logic

class ReconnectingRelayClient {
  private baseDelay = 500;     // 500ms initial delay
  private maxDelay = 30_000;   // 30s maximum delay
  private maxAttempts = 20;    // Give up after 20 attempts
  private attempt = 0;

  private async reconnect(): Promise<void> {
    while (this.attempt < this.maxAttempts) {
      const delay = Math.min(
        this.baseDelay * Math.pow(2, this.attempt) + Math.random() * 1000,
        this.maxDelay,
      );
      await new Promise(r => setTimeout(r, delay));
      try {
        await this.connect();
        this.attempt = 0; // Reset on success
        return;
      } catch {
        this.attempt++;
      }
    }
    throw new Error("max reconnection attempts exceeded");
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| JSON file for all persistence | SQLite for messages, JSON for connections | Phase 3 | Messages need indexed queries, pagination, and concurrent access that JSON cannot provide efficiently |
| No reconnection in RelayClient | Exponential backoff with jitter | Phase 3 | Phase 2 explicitly deferred reconnection. Phase 3 requires persistent connection for real-time delivery |
| Empty pubkey fields in connection exchange | Actual Ed25519 public keys exchanged | Phase 3 | Phase 2 sent empty Uint8Array for sender_public_key/responder_public_key. Encryption requires the actual keys |
| Envelope-only message types (no content) | Full encrypt/decrypt message flow | Phase 3 | Phase 2 tested message routing with empty envelopes. Phase 3 adds real encrypted content inside EncryptedPayload |

**Deprecated/outdated:**
- Node.js built-in `node:sqlite` (experimental in Node 22): Not stable enough for production use. Stick with better-sqlite3.

## Open Questions

1. **DeliveryConfirm protobuf schema needs definition**
   - What we know: The `MESSAGE_TYPE_DELIVERY_CONFIRM` enum value exists. The `EncryptedPayload` protobuf is defined for encrypted messages.
   - What's unclear: There is no `DeliveryConfirm` payload message in the proto file yet. We need to define one that carries the signature, message_id, timestamp, and delivery state.
   - Recommendation: Add a `DeliveryConfirm` message to `envelope.proto` with fields: `bytes message_id`, `bytes signature`, `int64 timestamp`, `string state`. Regenerate with buf. This is a proto schema change, not a research gap.

2. **Public key exchange gap from Phase 2**
   - What we know: ConnectionRequest has `sender_public_key` field and ConnectionResponse has `responder_public_key` field, but both are sent as empty `Uint8Array(0)` in Phase 2 code.
   - What's unclear: Whether to fix this in ConnectionManager (populate the fields) or use `validateAddress()` to extract the public key from the pinch address.
   - Recommendation: Populate the protobuf fields with actual keys during connection exchange AND use validateAddress as a fallback for connections established before this fix. The pinch address embeds the public key in its base58 payload, so extraction is always possible.

3. **Relay-side 30-second buffer implementation**
   - What we know: User decided on a 30-second relay buffer for transient disconnects before marking as failed.
   - What's unclear: How this interacts with the existing hub.RouteMessage which silently drops messages to offline recipients.
   - Recommendation: Add a short-lived in-memory buffer in the hub: if recipient is offline, hold the message for 30 seconds (checking periodically if they reconnect). If they don't, drop it. This is simpler than the Phase 4 bbolt queue and is explicitly temporary.

4. **OpenClaw activity feed integration for Full Manual**
   - What we know: Full Manual messages should appear as pending items in the OpenClaw activity feed for human review.
   - What's unclear: The exact OpenClaw API for pushing items to the activity feed. The heartbeat mechanism reads HEARTBEAT.md, but the "activity feed" may be a separate concept.
   - Recommendation: Use HEARTBEAT.md as the integration point for v1. When messages arrive in Full Manual mode, write a human-readable summary to a pending items file. On heartbeat, the agent reads this file and surfaces items. This is the simplest integration that matches documented OpenClaw patterns. More sophisticated activity feed integration can be added when OpenClaw's API is better understood.

5. **Thread ID generation strategy**
   - What we know: User decided thread_id is essential. Generation method is at Claude's discretion.
   - What's unclear: Whether to use UUIDv7 (consistent with message_id) or a human-readable format.
   - Recommendation: Use UUIDv7 for thread_id (same as message_id). Consistency simplifies the codebase. If the first message in a thread has no thread_id, auto-generate one and use that message's ID as the thread_id. Subsequent replies in the thread inherit it.

## Sources

### Primary (HIGH confidence)
- Existing codebase (`/Users/riecekeck/Coding/Pinch/skill/src/crypto.ts`) -- NaCl box encrypt/decrypt implementation verified
- Existing codebase (`/Users/riecekeck/Coding/Pinch/skill/src/relay-client.ts`) -- WebSocket connection and auth handshake verified
- Existing codebase (`/Users/riecekeck/Coding/Pinch/proto/pinch/v1/envelope.proto`) -- All protobuf schemas verified
- Existing codebase (`/Users/riecekeck/Coding/Pinch/skill/src/connection.ts`) -- ConnectionManager lifecycle verified
- Existing codebase (`/Users/riecekeck/Coding/Pinch/relay/internal/hub/hub.go`) -- Hub routing verified
- [libsodium documentation](https://libsodium.gitbook.io/doc/public-key_cryptography/public-key_signatures) -- crypto_sign_detached API verified
- [better-sqlite3 GitHub](https://github.com/WiseLibs/better-sqlite3) -- Synchronous API, WAL mode, prepared statements verified
- [OpenClaw skills docs](https://docs.openclaw.ai/tools/skills) -- SKILL.md format and frontmatter fields verified
- [OpenClaw heartbeat docs](https://docs.openclaw.ai/gateway/heartbeat) -- HEARTBEAT.md pattern and heartbeat cycle verified
- [ClawHub skill format spec](https://github.com/openclaw/clawhub/blob/main/docs/skill-format.md) -- Full YAML frontmatter field reference verified

### Secondary (MEDIUM confidence)
- [OpenClaw gateway protocol](https://docs.openclaw.ai/gateway/protocol) -- WebSocket protocol, tool execution patterns
- Web search results for exponential backoff patterns -- Standard algorithm verified across multiple sources

### Tertiary (LOW confidence)
- Exact OpenClaw activity feed API -- No official documentation found for programmatic activity feed integration. Using HEARTBEAT.md as proxy. Needs validation when building SKIL-04.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All core libraries already in use or well-documented (better-sqlite3 has 1.5M weekly npm downloads)
- Architecture: HIGH -- Patterns directly compose existing Phase 1/2 modules. No novel architecture needed.
- Pitfalls: HIGH -- Identified from direct code review of Phase 2 gaps (empty pubkey fields, no reconnection)
- OpenClaw integration: MEDIUM -- SKILL.md format well-documented, but activity feed and persistent skill patterns have limited documentation

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (30 days -- stable domain, no fast-moving dependencies)
