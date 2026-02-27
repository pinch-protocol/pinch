# Phase 2: Authentication and Connection - Research

**Researched:** 2026-02-26
**Domain:** Ed25519 challenge-response authentication, connection lifecycle, relay-side blocking, autonomy state
**Confidence:** HIGH

## Summary

Phase 2 transforms the relay from an unauthenticated WebSocket hub into a cryptographically verified routing layer, and adds the full connection lifecycle (request, approve/reject, block, revoke) with baseline autonomy levels. The existing Phase 1 codebase provides all the cryptographic primitives needed: Ed25519 keypairs exist in both Go and TypeScript, the protobuf schema already defines `AUTH_CHALLENGE`, `AUTH_RESPONSE`, `CONNECTION_REQUEST`, and `CONNECTION_RESPONSE` message type enums (but no corresponding payload messages yet), and the relay hub already maps `pinch:` addresses to WebSocket clients.

The primary work is: (1) extend the protobuf schema with auth and connection payload messages, (2) replace the relay's unauthenticated `?address=` query parameter flow with a post-WebSocket-upgrade challenge-response handshake, (3) implement connection request/response routing through the relay, (4) persist connection state (including block lists and autonomy levels) on the agent side, and (5) enforce blocking at the relay level.

**Primary recommendation:** Use the existing `crypto/ed25519` (Go) and `libsodium-wrappers-sumo` (TypeScript) libraries for all signing/verification -- no new crypto dependencies. Add `go.etcd.io/bbolt` on the relay side for block list persistence, and use a simple JSON file store on the TypeScript skill side for connection state.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Connection requests carry the sender's `pinch:` address plus a free-text short message (e.g., "Hey, it's Alice's research agent")
- Incoming requests surface in the agent's activity feed as an event
- Rejected requests result in silent rejection -- sender receives no feedback and cannot infer whether the recipient exists
- Pending requests expire after a configurable TTL (Claude picks a sensible default, e.g., 7 days)
- Blocking results in silent drop -- relay discards messages from the blocked pubkey with no indication to the sender
- Revoking sends a "connection ended" signal to the other party before severing -- the revoked agent knows the connection was terminated
- After a revoke, either party can immediately send a new connection request to reconnect
- Upgrading from Full Manual to Full Auto requires a confirmation step with a clear warning ("This agent will process messages without your approval")
- Full Auto is available immediately on any connection -- no trust-building period required
- In Full Manual mode, queued inbound messages are presented one at a time for individual approve/reject
- Downgrading from Full Auto to Full Manual takes effect immediately
- Connections support user-assigned nicknames that are local-only
- A contacts list shows all connections with four states: Active, Pending, Blocked, Revoked -- nothing disappears from view
- Each contact entry shows: nickname, pinch address, state, last activity
- Autonomy level (Full Manual / Full Auto) is shown subtly as secondary info on each contact

### Claude's Discretion
- Whether blocking is reversible (unblock restores connection) or permanent (must re-request) -- pick based on security tradeoffs
- Exact TTL default for pending connection requests
- Connection request message length limits
- Contacts list sorting and filtering behavior
- Challenge-response protocol details (nonce size, timeout)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RELY-02 | Relay authenticates agents via Ed25519 challenge-response (relay sends nonce, agent signs, relay verifies) | Auth challenge/response protobuf messages, Go `ed25519.Verify`, TS `crypto_sign_detached` / `crypto_sign_verify_detached`, relay wsHandler rewrite |
| CONN-01 | Agent can send a connection request to another agent's `pinch:` address | `ConnectionRequest` protobuf message with sender address + short message, relay routes to recipient if online |
| CONN-02 | Receiving agent's human sees connection request and can approve or reject | Agent-side connection store surfaces pending requests, skill exposes approve/reject actions |
| CONN-03 | On approval, agents exchange public keys and the connection is established | `ConnectionResponse` protobuf message carries acceptor's public key back to requester, both sides persist the connection |
| CONN-04 | Agent can block a connection -- relay rejects all messages from blocked pubkey | Relay-side block list (bbolt or in-memory + notification), agent sends block notification to relay, relay drops matching messages silently |
| CONN-06 | Either party can revoke a connection at any time, severing the channel without blocking | `ConnectionRevoke` message type, relay routes the revoke notification then both sides mark connection as revoked |
| AUTO-01 | Each connection has a configurable autonomy level: Full Manual or Full Auto (Notify and Auto-respond deferred to Phase 5) | Per-connection autonomy field in connection store, only two values for Phase 2 |
| AUTO-02 | New connections default to Full Manual -- human approves every inbound message | Default value in connection creation code, enforced before message processing |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `crypto/ed25519` (Go stdlib) | Go 1.24 | Sign/verify nonce challenge on relay | Standard library, already used in Phase 1 identity module, zero additional dependencies |
| `libsodium-wrappers-sumo` | 0.8.0 | Sign/verify nonce challenge on agent (TS) | Already a project dependency, provides `crypto_sign_detached` and `crypto_sign_verify_detached` |
| `go.etcd.io/bbolt` | v1.4.x | Relay-side persistent block list storage | Roadmap already calls for bbolt in Phase 4 (store-and-forward), adding it now for block list persistence means no new dependency in Phase 4 |
| `@bufbuild/protobuf` | ^2.11.0 | Protobuf serialization for auth and connection messages | Already a project dependency, protobuf-es v2 |
| `github.com/coder/websocket` | v1.8.14 | WebSocket transport for auth handshake | Already used in Phase 1 relay |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `buf` CLI | latest | Regenerate Go + TS code after proto changes | Whenever `envelope.proto` is modified |
| `vitest` | latest | TypeScript test runner | Already configured in skill, use for connection store and auth tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| bbolt for relay block list | In-memory map | Loses block list on relay restart -- unacceptable for security-critical blocking |
| bbolt for relay block list | SQLite via `modernc.org/sqlite` | More powerful queries but heavier dependency; bbolt is simpler and already planned for Phase 4 |
| JSON file for agent connection store | SQLite (better-sqlite3) | Overkill for the small number of connections an individual agent manages; JSON is simpler for Phase 2 |

**Installation:**
```bash
# Go side (relay) -- add bbolt
cd relay && go get go.etcd.io/bbolt@latest

# TypeScript side -- no new dependencies needed
# libsodium-wrappers-sumo already provides crypto_sign_detached
```

## Architecture Patterns

### Recommended Project Structure
```
proto/pinch/v1/
  envelope.proto          # Extended with AuthChallenge, AuthResponse,
                          # ConnectionRequest, ConnectionResponse,
                          # ConnectionRevoke, BlockNotification messages

relay/
  internal/
    auth/                 # NEW: challenge-response authentication
      auth.go             # Challenge generation, signature verification
      auth_test.go
    hub/
      client.go           # Modified: auth state on client, block checking
      hub.go              # Modified: register only after auth, block enforcement
      hub_test.go         # Extended with auth tests
    store/                # NEW: relay-side persistent storage
      blockstore.go       # bbolt-backed block list
      blockstore_test.go
  cmd/pinchd/
    main.go               # Modified: wsHandler does auth handshake

skill/src/
  auth.ts                 # NEW: challenge signing
  auth.test.ts
  connection-store.ts     # NEW: local connection state persistence
  connection-store.test.ts
  connection.ts           # NEW: connection request/response/revoke logic
  connection.test.ts
  relay-client.ts         # Modified: auth handshake on connect
```

### Pattern 1: Post-Upgrade Auth Handshake
**What:** After WebSocket upgrade, relay sends a challenge and waits for a signed response before registering the client in the routing table. No messages are routed until auth completes.
**When to use:** Every new WebSocket connection.
**Example:**
```
Client                          Relay
  |--- WebSocket Upgrade -------->|
  |<-- WS Upgrade OK ------------|
  |<-- AuthChallenge(nonce) ------|  relay generates 32-byte random nonce
  |--- AuthResponse(sig, pubkey)->|  client signs nonce with Ed25519 private key
  |                               |  relay: ed25519.Verify(pubkey, nonce, sig)
  |                               |  relay: derive pinch: address from pubkey
  |                               |  relay: register client in hub routing table
  |<-- AuthResult(ok/fail) ------|
```

**Key details:**
- Nonce: 32 bytes from crypto/rand (Go) -- same size as Ed25519 public key, provides 256-bit security
- Auth timeout: 10 seconds from challenge sent to valid response -- prevents resource exhaustion from connections that never complete auth
- The relay removes the `?address=` query parameter entirely -- address is derived from the authenticated public key
- Client sends its full 32-byte Ed25519 public key in the AuthResponse so the relay can derive the `pinch:` address
- Signature is 64 bytes (Ed25519 standard)

### Pattern 2: Connection Request Routing
**What:** Connection requests are routed through the relay like any other message. The relay checks the recipient exists in the routing table (or queues for later -- but queuing is Phase 4, so for Phase 2 the recipient must be online).
**When to use:** When an agent wants to connect to another agent.
**Example:**
```
Agent A                    Relay                    Agent B
  |-- ConnRequest --------->|                          |
  |  (to: B's pinch addr,  |--- ConnRequest --------->|
  |   message: "Hi...")     |                          |
  |                         |                          |-- human sees request
  |                         |                          |-- human approves
  |                         |<--- ConnResponse --------|
  |<-- ConnResponse --------|    (accepted: true,      |
  |  (B's pubkey)           |     pubkey: B's key)     |
  |                         |                          |
  | Both sides persist connection with each other's pubkey |
```

**Phase 2 scope:** If recipient is offline, the connection request is silently dropped (no store-and-forward yet). The sender gets no feedback either way (consistent with silent rejection behavior for non-existent recipients).

### Pattern 3: Block Enforcement at Relay
**What:** When an agent blocks another, the agent notifies the relay. The relay persists the block in bbolt and silently drops all future messages from the blocked pubkey to the blocking agent.
**When to use:** Agent blocks a connection.
**Example:**
```go
// Relay block check in message routing
func (h *Hub) RouteMessage(from, to string, msg []byte) error {
    // Check block list BEFORE looking up recipient
    if h.blockStore.IsBlocked(to, from) {
        // Silent drop -- no error to sender
        return nil
    }
    recipient, ok := h.LookupClient(to)
    if !ok {
        return nil // recipient offline, silent drop
    }
    recipient.Send(msg)
    return nil
}
```

### Pattern 4: Agent-Side Connection Store
**What:** Each agent persists its connection state (contacts list) as a JSON file. The store tracks: peer pubkey, peer address, state (Active/Pending/Blocked/Revoked), nickname, autonomy level, last activity timestamp.
**When to use:** All connection state management on the agent side.
**Example:**
```typescript
interface Connection {
  peerAddress: string;       // pinch:<hash>@<relay>
  peerPublicKey: string;     // base64-encoded Ed25519 pubkey
  state: "active" | "pending_outbound" | "pending_inbound" | "blocked" | "revoked";
  nickname: string;          // local-only, user-assigned
  autonomyLevel: "full_manual" | "full_auto";
  shortMessage?: string;     // from connection request
  createdAt: string;         // ISO timestamp
  lastActivity: string;      // ISO timestamp
  expiresAt?: string;        // for pending requests, ISO timestamp
}

interface ConnectionStore {
  version: number;
  connections: Record<string, Connection>; // keyed by peerAddress
}
```

### Anti-Patterns to Avoid
- **Sending block notifications to the blocked party:** Blocking is silent. The blocked agent must receive zero indication. Do not send a "you have been blocked" message.
- **Authenticating via query parameter:** Phase 1's `?address=` pattern was intentionally temporary. Phase 2 MUST replace it with the post-upgrade challenge-response. Any agent can claim any address via query parameter -- this is the security hole Phase 2 closes.
- **Deriving address client-side for auth:** The relay must derive the `pinch:` address from the public key the client provides during auth. The client does not get to choose its address -- the relay computes it from the verified public key.
- **Blocking at the agent level only:** Block enforcement must happen at the relay. If blocking were only agent-side, the blocked agent could still deliver messages to the relay and consume bandwidth/resources.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Nonce generation | Custom RNG | `crypto/rand.Read` (Go), `sodium.randombytes_buf` (TS) | CSPRNG is critical for security; stdlib is audited |
| Ed25519 signing | Custom signing | `ed25519.Sign` / `ed25519.Verify` (Go), `crypto_sign_detached` / `crypto_sign_verify_detached` (TS) | Timing attacks, implementation bugs in hand-rolled crypto |
| Block list persistence | Custom file format | bbolt buckets | Crash-safe, ACID transactions, already needed for Phase 4 |
| Protobuf serialization | Custom wire format | buf-generated code from .proto schema | Cross-language consistency, versioning, schema evolution |
| WebSocket framing | Raw TCP | `github.com/coder/websocket` (Go), `ws` (TS) | Already in use, handles compression/framing/close codes |

**Key insight:** Phase 2 is a security-critical phase. Every crypto operation must use audited library functions. The existing project already has the right libraries -- no new crypto dependencies are needed.

## Common Pitfalls

### Pitfall 1: Auth Race Condition
**What goes wrong:** Client sends messages before auth completes, relay routes them because the client is already registered in the hub.
**Why it happens:** Registering the client in the hub before auth verification is complete.
**How to avoid:** Do NOT register the client in the hub until auth succeeds. The WebSocket upgrade handler should: (1) accept the WS upgrade, (2) perform the entire challenge-response inline, (3) only then create the Client and register it with the hub.
**Warning signs:** Messages appearing from addresses that haven't completed auth; goroutine ordering issues in tests.

### Pitfall 2: Nonce Reuse
**What goes wrong:** If the relay reuses or generates predictable nonces, an attacker could pre-compute signatures.
**Why it happens:** Using a counter, timestamp, or non-CSPRNG source for nonce generation.
**How to avoid:** Use `crypto/rand.Read` for 32 bytes. Check the error return. Never use `math/rand`.
**Warning signs:** Nonces that look sequential in logs.

### Pitfall 3: Block List Bypass via Reconnection
**What goes wrong:** A blocked agent disconnects and reconnects, and the block list is not checked because it was only in memory.
**Why it happens:** Block list stored only in the hub's in-memory state, lost on relay restart or not checked on new connections.
**How to avoid:** Persist block lists in bbolt. On every message route, check bbolt (with a read transaction, which is fast and concurrent in bbolt). Also check blocks when a new client authenticates -- if A blocked B, and B reconnects, B's messages to A are still silently dropped.
**Warning signs:** Blocked agents successfully delivering messages after relay restart.

### Pitfall 4: Connection State Divergence
**What goes wrong:** Agent A thinks the connection is active, but Agent B revoked it. Messages from A go into a void.
**Why it happens:** Revoke notification didn't reach A (was offline, network issue).
**How to avoid:** For Phase 2, revoke only works when both agents are online (no store-and-forward). Document this limitation. The relay sends the revoke notification to the other party; if they're offline, they will not receive it until Phase 4 adds message queuing. In the meantime, messages from the unaware party are simply not delivered (recipient is offline anyway, or has removed the connection from their store).
**Warning signs:** Tests that assume revoke works across offline scenarios in Phase 2.

### Pitfall 5: Exposing Recipient Existence
**What goes wrong:** Different error responses or timing for "recipient exists but rejected" vs "recipient doesn't exist" leaks information.
**Why it happens:** Naive error handling that returns different status codes or messages.
**How to avoid:** Silent rejection for connection requests must be indistinguishable from "recipient not found." Both cases: no response to sender. Same timing. No error message.
**Warning signs:** Different code paths for "not found" vs "rejected" that produce observable differences.

### Pitfall 6: Forgetting to Update Proto and Regenerate
**What goes wrong:** New protobuf messages added but `buf generate` not run, or run but generated files not committed. Go and TypeScript code gets out of sync.
**Why it happens:** Manual step that's easy to forget.
**How to avoid:** Add proto schema changes and code regeneration as the FIRST task in the plan. Verify generated Go and TS files match.
**Warning signs:** Import errors, missing types, CI failures.

## Code Examples

Verified patterns from official sources and existing codebase:

### Ed25519 Challenge-Response (Go Relay Side)
```go
// Source: crypto/ed25519 stdlib (https://pkg.go.dev/crypto/ed25519)
import (
    "crypto/ed25519"
    "crypto/rand"
)

// GenerateChallenge creates a 32-byte random nonce for auth.
func GenerateChallenge() ([]byte, error) {
    nonce := make([]byte, 32)
    _, err := rand.Read(nonce)
    return nonce, err
}

// VerifyChallenge checks the client's signature of the nonce.
func VerifyChallenge(pubKey ed25519.PublicKey, nonce, signature []byte) bool {
    return ed25519.Verify(pubKey, nonce, signature)
}
```

### Ed25519 Challenge Signing (TypeScript Agent Side)
```typescript
// Source: libsodium docs (https://libsodium.gitbook.io/doc/public-key_cryptography/public-key_signatures)
import sodium from "libsodium-wrappers-sumo";

// Sign a challenge nonce with the agent's Ed25519 private key.
function signChallenge(nonce: Uint8Array, privateKey: Uint8Array): Uint8Array {
    return sodium.crypto_sign_detached(nonce, privateKey);
}

// Verify a signature (used in cross-language tests).
function verifySignature(
    signature: Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
): boolean {
    return sodium.crypto_sign_verify_detached(signature, nonce, publicKey);
}
```

### Protobuf Schema Extensions (Additions to envelope.proto)
```protobuf
// Auth messages for challenge-response handshake
message AuthChallenge {
    bytes nonce = 1;          // 32-byte random challenge
    int64 timestamp = 2;      // server timestamp for timeout tracking
}

message AuthResponse {
    bytes signature = 1;       // 64-byte Ed25519 signature of the nonce
    bytes public_key = 2;      // 32-byte Ed25519 public key
}

message AuthResult {
    bool success = 1;
    string error_message = 2;  // only populated on failure
    string assigned_address = 3; // the pinch: address derived from pubkey
}

// Connection lifecycle messages
message ConnectionRequest {
    string from_address = 1;
    string to_address = 2;
    string message = 3;        // free-text short message
    bytes sender_public_key = 4;
    int64 expires_at = 5;      // Unix timestamp for TTL
}

message ConnectionResponse {
    string from_address = 1;
    string to_address = 2;
    bool accepted = 3;
    bytes responder_public_key = 4; // only populated if accepted
}

message ConnectionRevoke {
    string from_address = 1;
    string to_address = 2;
}

message BlockNotification {
    string blocker_address = 1;
    string blocked_address = 2;
}

// Add to Envelope.oneof payload:
//   AuthChallenge auth_challenge = 13;
//   AuthResponse auth_response = 14;
//   AuthResult auth_result = 15;
//   ConnectionRequest connection_request = 16;
//   ConnectionResponse connection_response = 17;
//   ConnectionRevoke connection_revoke = 18;
//   BlockNotification block_notification = 19;
```

### bbolt Block Store (Go Relay Side)
```go
// Source: bbolt API (https://pkg.go.dev/go.etcd.io/bbolt)
import bolt "go.etcd.io/bbolt"

var blocksBucket = []byte("blocks")

type BlockStore struct {
    db *bolt.DB
}

func NewBlockStore(path string) (*BlockStore, error) {
    db, err := bolt.Open(path, 0600, nil)
    if err != nil {
        return nil, err
    }
    // Create the blocks bucket on init.
    err = db.Update(func(tx *bolt.Tx) error {
        _, err := tx.CreateBucketIfNotExists(blocksBucket)
        return err
    })
    return &BlockStore{db: db}, err
}

// Block records that blockerAddr has blocked blockedAddr.
// Key format: "blockerAddr:blockedAddr" -> "1"
func (s *BlockStore) Block(blockerAddr, blockedAddr string) error {
    return s.db.Update(func(tx *bolt.Tx) error {
        b := tx.Bucket(blocksBucket)
        key := []byte(blockerAddr + ":" + blockedAddr)
        return b.Put(key, []byte("1"))
    })
}

// IsBlocked checks if blockerAddr has blocked senderAddr.
func (s *BlockStore) IsBlocked(blockerAddr, senderAddr string) bool {
    var blocked bool
    s.db.View(func(tx *bolt.Tx) error {
        b := tx.Bucket(blocksBucket)
        key := []byte(blockerAddr + ":" + senderAddr)
        blocked = b.Get(key) != nil
        return nil
    })
    return blocked
}
```

### Connection Store (TypeScript Agent Side)
```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface Connection {
    peerAddress: string;
    peerPublicKey: string;  // base64
    state: "active" | "pending_outbound" | "pending_inbound" | "blocked" | "revoked";
    nickname: string;
    autonomyLevel: "full_manual" | "full_auto";
    shortMessage?: string;
    createdAt: string;
    lastActivity: string;
    expiresAt?: string;
}

interface StoreData {
    version: number;
    connections: Record<string, Connection>;
}

class ConnectionStore {
    private data: StoreData = { version: 1, connections: {} };

    constructor(private path: string) {}

    async load(): Promise<void> {
        try {
            const raw = await readFile(this.path, "utf-8");
            this.data = JSON.parse(raw);
        } catch {
            this.data = { version: 1, connections: {} };
        }
    }

    async save(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, JSON.stringify(this.data, null, 2));
    }

    getConnection(peerAddress: string): Connection | undefined {
        return this.data.connections[peerAddress];
    }

    listConnections(): Connection[] {
        return Object.values(this.data.connections);
    }
}
```

## Discretionary Decisions (Researcher Recommendations)

These items were marked as "Claude's Discretion" in CONTEXT.md. Recommendations based on research:

### Blocking reversibility
**Recommendation: Reversible (unblock restores connection).** Rationale: Permanent blocking forces a full re-request dance even for accidental blocks. Since blocking is already a strong action (silent drop), making unblock available gives the human a recovery path. The relay's bbolt block store simply deletes the key on unblock. If the user wants to ensure a fresh start, they can revoke instead. Security impact is minimal because unblocking requires explicit human action on the blocking side.

### Pending request TTL
**Recommendation: 7 days (604800 seconds).** This is the value the user suggested. It provides enough time for a human who checks their agent infrequently to notice and respond to requests, without accumulating stale requests indefinitely.

### Connection request message length limit
**Recommendation: 280 characters.** Short enough to prevent abuse, long enough for a meaningful introduction. This is a familiar length constraint (Twitter-length). Enforced at both the sending agent and relay.

### Contacts list sorting
**Recommendation: Sort by state first (Active > Pending > Revoked > Blocked), then by last activity (most recent first) within each state group.** Active connections with recent messages should be at the top. Blocked connections at the bottom since they are rarely interacted with.

### Challenge-response nonce size and timeout
**Recommendation: 32-byte nonce, 10-second auth timeout.** 32 bytes provides 256-bit entropy, matching Ed25519's security level. 10 seconds is generous for network latency but prevents resource exhaustion from connections that open a WebSocket and never authenticate.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `?address=` query param (Phase 1) | Post-upgrade Ed25519 challenge-response | Phase 2 | Closes impersonation attack vector |
| No block enforcement | Relay-enforced blocking with bbolt persistence | Phase 2 | Blocked agents cannot consume any relay resources for the blocker |
| No connection consent | Mutual-consent connection requests | Phase 2 | No unsolicited messages -- human must approve every connection |

**Deprecated/outdated:**
- `?address=` query parameter authentication: replaced by cryptographic auth. The wsHandler must be completely rewritten.
- `hub.NewClient` taking address as parameter: address will be derived from authenticated public key instead.

## Open Questions

1. **Relay-side connection state**
   - What we know: The relay needs to know about blocks (to enforce them). Connection requests/responses are routed through the relay.
   - What's unclear: Should the relay also persist connection state (who is connected to whom), or should it only persist block lists and route connection messages blindly?
   - Recommendation: Relay persists ONLY block lists. Connection state is agent-side. The relay routes connection messages like any other message -- it does not need to understand the connection lifecycle. This keeps the relay simple and privacy-preserving (it doesn't know who is connected to whom, only who is blocked).

2. **Auth failure handling**
   - What we know: The relay must close the WebSocket if auth fails.
   - What's unclear: Should the relay send an error message before closing, or just close with a specific WebSocket close code?
   - Recommendation: Send an `AuthResult(success: false, error_message: "...")` before closing with WebSocket close code 4001 (custom application code). This gives the agent useful debugging info during development.

3. **Block notification delivery to relay**
   - What we know: When an agent blocks another, the relay must be informed so it can enforce the block.
   - What's unclear: Should this be a special protobuf message type, or a REST endpoint on the relay?
   - Recommendation: Use a protobuf message (`BlockNotification`) sent over the existing WebSocket connection. This keeps all communication on a single channel and avoids needing HTTP auth for a separate REST endpoint. The relay processes the block notification from the authenticated agent, persists it in bbolt, and starts enforcing immediately.

## Sources

### Primary (HIGH confidence)
- [Go crypto/ed25519 package](https://pkg.go.dev/crypto/ed25519) - Sign/Verify API, key sizes, constants
- [libsodium public-key signatures docs](https://libsodium.gitbook.io/doc/public-key_cryptography/public-key_signatures) - crypto_sign_detached / crypto_sign_verify_detached API
- [bbolt GitHub repository](https://github.com/etcd-io/bbolt) - embedded KV store API, bucket patterns
- Existing codebase: `relay/internal/crypto/crypto.go`, `skill/src/crypto.ts`, `skill/src/identity.ts` - verified existing Ed25519 and NaCl primitives

### Secondary (MEDIUM confidence)
- [Challenge-response authentication (Wikipedia)](https://en.wikipedia.org/wiki/Challenge%E2%80%93response_authentication) - general pattern description
- [NIST CSRC challenge-response protocol glossary](https://csrc.nist.gov/glossary/term/challenge_response_protocol) - nonce security requirements

### Tertiary (LOW confidence)
- None -- all findings verified against primary sources or existing codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already in project or well-established (bbolt is etcd-maintained, battle-tested)
- Architecture: HIGH - auth handshake and connection routing patterns are well-understood; existing codebase structure is clear
- Pitfalls: HIGH - pitfalls derived from analysis of existing code structure and standard crypto engineering practices

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (stable domain, no fast-moving dependencies)
