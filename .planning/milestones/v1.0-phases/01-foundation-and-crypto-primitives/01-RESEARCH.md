# Phase 1 Research: Foundation and Crypto Primitives

**Phase:** 01-foundation-and-crypto-primitives
**Researched:** 2026-02-26
**Confidence:** HIGH -- all technologies are well-documented with verified library versions

## What This Phase Must Deliver

A working monorepo where: Go relay accepts WebSocket connections, TypeScript skill connects, Ed25519 keypairs generate addresses, protobuf messages serialize cross-language, and crypto roundtrip tests pass in CI. No authentication, no message delivery logic, no connection management.

**Requirement IDs:** IDNT-01, IDNT-02, IDNT-03, PROT-01, PROT-02, PROT-03, PROT-04, RELY-01, RELY-03, RELY-08, CRYP-02, CRYP-03, CRYP-04

---

## 1. Monorepo Layout and Tooling

### Structure

The user decided on the following layout (from 01-CONTEXT.md):
- pnpm for TypeScript package management with workspaces
- buf for protobuf code generation (Go + TypeScript from single buf.yaml)
- Go module scoped to `relay/` directory (go.mod inside relay/, not at repo root)
- Folder naming at Claude's discretion

**Recommended top-level structure:**

```
pinch/
  relay/           # Go relay server (go.mod lives here)
    cmd/pinchd/    # Binary entry point
    internal/      # Unexported packages (hub, protocol, crypto)
  skill/           # TypeScript OpenClaw skill (package.json lives here)
    src/
  proto/           # Shared .proto files (single source of truth)
  gen/             # Generated code output
    go/            # Generated Go protobuf code
    ts/            # Generated TypeScript protobuf code
  pnpm-workspace.yaml
  buf.yaml         # Buf module configuration
  buf.gen.yaml     # Code generation configuration
```

**Key decision:** The `gen/` directory lives at monorepo root (not inside relay/ or skill/) because buf generates code for both targets from the same proto files. Both relay/ and skill/ import from gen/.

### pnpm Workspace Configuration

```yaml
# pnpm-workspace.yaml
packages:
  - 'skill'
  - 'gen/ts'
```

The `gen/ts` package needs its own `package.json` so the skill can import generated protobuf types as a workspace dependency: `"@pinch/proto": "workspace:*"`.

### buf Configuration

**buf.yaml** (at repo root, next to proto/):

```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - DEFAULT
breaking:
  use:
    - FILE
```

**buf.gen.yaml** (at repo root):

```yaml
version: v2
clean: true
managed:
  enabled: true
plugins:
  - remote: buf.build/protocolbuffers/go
    out: gen/go
    opt:
      - paths=source_relative
  - remote: buf.build/bufbuild/protobuf-es
    out: gen/ts
    opt:
      - target=ts
inputs:
  - directory: proto
```

Running `buf generate` produces Go code in `gen/go/` and TypeScript code in `gen/ts/`. The `clean: true` option deletes old generated files before regeneration.

**buf lint** runs in CI to catch backward-incompatible proto changes. This matters because both Go and TypeScript must agree on the wire format -- proto schema drift would be a silent interoperability failure.

### Go Module Setup

```bash
cd relay/
go mod init github.com/<org>/pinch/relay
```

The relay imports generated protobuf code via a replace directive or a Go workspace (go.work) pointing to `../gen/go`. A go.work file at repo root is the cleaner approach:

```
go 1.22

use (
    ./relay
    ./gen/go
)
```

### TypeScript Setup

```bash
cd skill/
pnpm init
pnpm add libsodium-wrappers-sumo@0.8.0
pnpm add @bufbuild/protobuf@2.11.0
pnpm add ws@8
pnpm add -D @types/ws typescript vitest @biomejs/biome
```

The `@types/libsodium-wrappers-sumo` types ship with the package. TypeScript 5.x with strict mode enabled.

### CI (GitHub Actions)

Matrix build with two jobs:
1. **Go**: `go test ./...` in relay/, `golangci-lint run`
2. **TypeScript**: `pnpm test` (vitest), `pnpm biome check`
3. **Cross-language**: Integration test that runs both Go and TypeScript processes to verify crypto interoperability

The cross-language crypto tests should run as a separate CI job that depends on both Go and TypeScript builds passing first.

---

## 2. Protocol Buffer Envelope Design

### User Decisions (from 01-CONTEXT.md)

- Outer + inner envelope structure: outer (unencrypted) has routing/metadata, inner is encrypted ciphertext blob
- Relay reads outer envelope for routing, never sees inner payload
- Proto enum for message types
- Versioned proto namespace: `package pinch.v1`
- Single Envelope message with `oneof` payload field containing all message type variants

### Proto Schema Design

The envelope must satisfy these Phase 1 requirements simultaneously:
- **PROT-01**: All wire messages use Protocol Buffers with shared schema
- **PROT-02**: Protocol envelope includes a version field
- **PROT-03**: Encrypted payloads include sequence numbers for replay protection
- **PROT-04**: Encrypted payloads include timestamps for replay protection

**Critical design insight from PITFALLS.md**: Sequence numbers and timestamps must live INSIDE the encrypted payload, not in the cleartext outer envelope. The relay could tamper with cleartext fields. The outer envelope carries routing metadata only.

```protobuf
syntax = "proto3";
package pinch.v1;

// Outer envelope -- relay can read this for routing
message Envelope {
  uint32 version = 1;              // PROT-02: Protocol version (start at 1)
  string from_address = 2;         // Sender's pinch: address
  string to_address = 3;           // Recipient's pinch: address
  MessageType type = 4;            // Message type enum
  bytes message_id = 5;            // Unique message ID (relay-level dedup)
  int64 timestamp = 6;             // Relay-level timestamp (not trusted by recipients)
  oneof payload {
    EncryptedPayload encrypted = 10;
    Handshake handshake = 11;
    Heartbeat heartbeat = 12;
    // Future: AuthChallenge, AuthResponse, ConnectionRequest, etc.
  }
}

// Encrypted blob -- relay cannot read this
message EncryptedPayload {
  bytes nonce = 1;                 // 24-byte random nonce (CRYP-03)
  bytes ciphertext = 2;            // NaCl box output
  bytes sender_public_key = 3;     // Sender's Ed25519 public key (for verification)
}

// Plaintext inside the encrypted payload (after decryption)
// This is NOT a wire message -- it exists only in decrypted form at the client
message PlaintextPayload {
  uint32 version = 1;             // PROT-02: Redundant version inside encryption boundary
  uint64 sequence = 2;            // PROT-03: Monotonically increasing per-sender
  int64 timestamp = 3;            // PROT-04: Unix timestamp (milliseconds)
  bytes content = 4;              // Actual message content
  string content_type = 5;        // MIME type or application-defined type
}

enum MessageType {
  MESSAGE_TYPE_UNSPECIFIED = 0;
  MESSAGE_TYPE_HANDSHAKE = 1;
  MESSAGE_TYPE_AUTH_CHALLENGE = 2;
  MESSAGE_TYPE_AUTH_RESPONSE = 3;
  MESSAGE_TYPE_MESSAGE = 4;
  MESSAGE_TYPE_DELIVERY_CONFIRM = 5;
  MESSAGE_TYPE_CONNECTION_REQUEST = 6;
  MESSAGE_TYPE_CONNECTION_RESPONSE = 7;
  MESSAGE_TYPE_HEARTBEAT = 8;
}

message Handshake {
  uint32 version = 1;
  bytes signing_key = 2;           // Ed25519 public key
  bytes encryption_key = 3;        // X25519 public key (may derive from same keypair in v1)
}

message Heartbeat {
  int64 timestamp = 1;
}
```

### Why Separate signing_key and encryption_key in Handshake

PITFALLS.md explicitly flags single-keypair risk as a critical concern. Even though v1 derives both keys from the same Ed25519 keypair, the protocol envelope must have separate fields NOW so a future version can use independent keypairs without a breaking protocol change. The cost is zero (two fields vs. one) and the benefit is protocol evolvability.

### Protobuf oneof Handling

**Go**: The `oneof` generates an interface type. Use a type switch:
```go
switch p := envelope.Payload.(type) {
case *pinchv1.Envelope_Encrypted:
    handleEncrypted(p.Encrypted)
case *pinchv1.Envelope_Handshake:
    handleHandshake(p.Handshake)
}
```

**TypeScript** (protobuf-es v2): Uses a `case` field pattern:
```typescript
switch (envelope.payload.case) {
  case "encrypted":
    handleEncrypted(envelope.payload.value);
    break;
  case "handshake":
    handleHandshake(envelope.payload.value);
    break;
}
```

### Cross-Language Serialization Test Pattern

Create test vectors: a known Envelope with all fields populated, serialize in Go, deserialize in TypeScript (and vice versa). Check every field matches. This catches:
- Field numbering mismatches
- Enum value mapping errors
- Bytes encoding differences
- Timestamp precision issues (Go uses int64 nanos, TypeScript uses BigInt -- protobuf-es handles this but must be tested)

---

## 3. Ed25519 Identity and Address Format

### User Decisions (from 01-CONTEXT.md)

- Full 32-byte Ed25519 public key encoded in base58 (no truncation, no hashing)
- 4-byte checksum: first 4 bytes of SHA-256(pubkey) appended before base58 encoding
- Relay identifier is hostname only: `pinch:<base58_pubkey_with_checksum>@relay.example.com`
- No port in address

### Address Construction Algorithm

```
1. Generate Ed25519 keypair -> 32-byte public key
2. Compute SHA-256(public_key) -> 32-byte hash
3. Take first 4 bytes of hash -> checksum
4. Concatenate: public_key (32 bytes) + checksum (4 bytes) -> 36 bytes
5. Base58 encode the 36 bytes -> address string
6. Format: pinch:<base58_string>@<relay_hostname>
```

The 36-byte input produces roughly a 49-character base58 string (base58 expands ~1.37x). Total address length with prefix and relay: approximately `pinch:<49chars>@relay.example.com` = ~75 characters.

### Address Validation

On receipt of an address:
1. Parse `pinch:<payload>@<host>` (regex: `^pinch:([1-9A-HJ-NP-Za-km-z]+)@(.+)$`)
2. Base58 decode the payload -> 36 bytes
3. Split: public_key = bytes[0:32], checksum = bytes[32:36]
4. Recompute: SHA-256(public_key)[0:4]
5. Compare computed checksum with received checksum
6. Reject if mismatch (corrupt or tampered address)

### Library Requirements

**Go:**
- Ed25519 keypair: `crypto/ed25519` (stdlib) -- `ed25519.GenerateKey(rand.Reader)`
- Base58 encoding: `github.com/btcsuite/btcutil/base58` or `github.com/mr-tron/base58` -- both widely used, no dependencies
- SHA-256: `crypto/sha256` (stdlib)

**TypeScript:**
- Ed25519 keypair: `libsodium-wrappers-sumo` -- `sodium.crypto_sign_keypair()`
- Base58 encoding: `bs58` npm package (standard, used by Solana and Bitcoin ecosystems)
- SHA-256: `libsodium-wrappers-sumo` provides `sodium.crypto_hash_sha256()`, or use Node's `crypto.createHash('sha256')`

### Keypair Persistence (IDNT-01, IDNT-03)

**Requirements:**
- Agent generates an Ed25519 keypair and persists it securely
- Agent can load an existing keypair from storage on startup
- Same address must appear after restart

**Storage format:** JSON file containing:
```json
{
  "version": 1,
  "public_key": "<base64 encoded 32 bytes>",
  "private_key": "<base64 encoded 64 bytes>",
  "created_at": "2026-02-26T12:00:00Z"
}
```

For Phase 1, plaintext storage is acceptable -- the key file should be in a user-configurable location (default: `~/.pinch/identity.json`). PITFALLS.md flags plaintext key storage as a security concern, but encrypted-at-rest key storage (passphrase or OS keychain) is a post-Phase-1 enhancement. The file format includes a version field so encryption can be added later without breaking existing key files.

**Go implementation** (relay does not store keys in Phase 1 -- it only verifies public keys). The relay needs to derive addresses from public keys received during future auth handshakes, but does not generate or persist its own keypair until Phase 2 (auth).

**TypeScript implementation** (skill generates and persists keypair):
```typescript
import sodium from 'libsodium-wrappers-sumo';

await sodium.ready;
const keypair = sodium.crypto_sign_keypair();
// keypair.publicKey: Uint8Array (32 bytes)
// keypair.privateKey: Uint8Array (64 bytes -- seed + public key)
```

The `sodium.ready` promise MUST be awaited before any crypto operation. PITFALLS.md flags this as an integration gotcha: calling crypto functions before `sodium.ready` resolves causes silent failures or exceptions. Wrap initialization in a singleton that blocks until ready.

### Cross-Language Address Test

Both Go and TypeScript must produce the same `pinch:` address from the same Ed25519 public key. Test vectors:
- Use a known keypair (hardcoded seed) to generate the same keypair in both languages
- Both produce the same base58-encoded address with checksum
- Both validate each other's addresses successfully

---

## 4. Ed25519 to X25519 Key Conversion (CRYP-02)

This is the most technically nuanced part of Phase 1. Both languages must produce identical X25519 keys from the same Ed25519 keypair.

### Go Implementation

**Public key conversion** -- use `filippo.io/edwards25519`:
```go
import "filippo.io/edwards25519"

func Ed25519PublicToX25519(pub ed25519.PublicKey) ([]byte, error) {
    point, err := new(edwards25519.Point).SetBytes(pub)
    if err != nil {
        return nil, fmt.Errorf("invalid Ed25519 public key: %w", err)
    }
    return point.BytesMontgomery(), nil
}
```

`BytesMontgomery()` converts the Edwards point to the birationally-equivalent Curve25519 Montgomery form (RFC 7748).

**Private key conversion** -- derive from Ed25519 seed:
```go
import (
    "crypto/ed25519"
    "crypto/sha512"
)

func Ed25519PrivateToX25519(priv ed25519.PrivateKey) []byte {
    h := sha512.New()
    h.Write(priv.Seed())  // First 32 bytes of the 64-byte private key
    digest := h.Sum(nil)
    // Clamp per RFC 7748
    digest[0] &= 248
    digest[31] &= 127
    digest[31] |= 64
    return digest[:32]
}
```

**Important**: The clamping step (clearing low 3 bits of first byte, clearing high bit and setting second-high bit of last byte) is required by the X25519 specification. Without clamping, the derived key is not a valid X25519 scalar.

### TypeScript Implementation

**Public key conversion:**
```typescript
const x25519PubKey = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519PublicKey);
```

**Private key conversion:**
```typescript
const x25519PrivKey = sodium.crypto_sign_ed25519_sk_to_curve25519(ed25519PrivateKey);
```

These functions are ONLY available in `libsodium-wrappers-sumo`. The standard `libsodium-wrappers` package does NOT include them. This is a hard requirement for the sumo variant.

### Cross-Language Validation

From the same Ed25519 seed, both Go and TypeScript must produce:
1. The same Ed25519 public key
2. The same X25519 public key (after conversion)
3. The same X25519 private key (after conversion)

Test with multiple known seeds. The conversion is deterministic -- any difference indicates an implementation bug.

---

## 5. NaCl Box Encryption (CRYP-03, CRYP-04)

### How NaCl Box Works

NaCl box (`crypto_box_curve25519xsalsa20poly1305`) provides authenticated public-key encryption:
- **Key exchange**: X25519 Diffie-Hellman between sender's private key and recipient's public key
- **Symmetric cipher**: XSalsa20 stream cipher
- **Authentication**: Poly1305 MAC
- **Nonce**: 24 bytes, must be unique per (key-pair, message)

### Go Implementation

```go
import (
    "crypto/rand"
    "golang.org/x/crypto/nacl/box"
)

// Encrypt
func Encrypt(plaintext []byte, recipientPub, senderPriv *[32]byte) ([]byte, error) {
    var nonce [24]byte
    if _, err := rand.Read(nonce[:]); err != nil {
        return nil, err
    }
    // Seal prepends the nonce to the ciphertext
    sealed := box.Seal(nonce[:], plaintext, &nonce, recipientPub, senderPriv)
    return sealed, nil
}

// Decrypt
func Decrypt(sealed []byte, senderPub, recipientPriv *[32]byte) ([]byte, bool) {
    if len(sealed) < 24 {
        return nil, false
    }
    var nonce [24]byte
    copy(nonce[:], sealed[:24])
    return box.Open(nil, sealed[24:], &nonce, senderPub, recipientPriv)
}
```

**Function signatures (from Go docs):**
- `box.Seal(out, message []byte, nonce *[24]byte, peersPublicKey, privateKey *[32]byte) []byte`
- `box.Open(out, box []byte, nonce *[24]byte, peersPublicKey, privateKey *[32]byte) ([]byte, bool)`
- `box.GenerateKey(rand io.Reader) (publicKey, privateKey *[32]byte, err error)`

**Key sizes**: All keys are `*[32]byte`. Nonce is `*[24]byte`. Overhead is 16 bytes (Poly1305 MAC).

### TypeScript Implementation

```typescript
await sodium.ready;

// Encrypt
function encrypt(
  plaintext: Uint8Array,
  recipientX25519Pub: Uint8Array,
  senderX25519Priv: Uint8Array
): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES); // 24 bytes
  const ciphertext = sodium.crypto_box_easy(
    plaintext, nonce, recipientX25519Pub, senderX25519Priv
  );
  // Prepend nonce to ciphertext
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce);
  result.set(ciphertext, nonce.length);
  return result;
}

// Decrypt
function decrypt(
  sealed: Uint8Array,
  senderX25519Pub: Uint8Array,
  recipientX25519Priv: Uint8Array
): Uint8Array {
  const nonce = sealed.slice(0, sodium.crypto_box_NONCEBYTES);
  const ciphertext = sealed.slice(sodium.crypto_box_NONCEBYTES);
  return sodium.crypto_box_open_easy(
    ciphertext, nonce, senderX25519Pub, recipientX25519Priv
  );
}
```

### Nonce Safety (CRYP-03)

PITFALLS.md identifies nonce reuse as the #1 critical pitfall. The mitigation is straightforward:

- **Always use 24-byte random nonces from CSPRNG** -- `crypto/rand.Read()` in Go, `sodium.randombytes_buf()` in TypeScript
- **Never use counter-based nonces** -- counter state is lost on restart, and both parties might generate the same counter value
- **Prepend nonce to ciphertext** -- standard NaCl pattern; the receiver extracts the nonce from the first 24 bytes
- **24-byte nonce space** -- with 192 bits, random collision probability is ~2^-96 after 2^48 messages. Negligible for any realistic message volume.

**Test requirement**: Every test that encrypts must use a random nonce (not hardcoded). Tests should verify that encrypting the same plaintext twice produces different ciphertexts (because the nonce differs).

### Cross-Language Crypto Roundtrip (CRYP-04)

This is a critical CI requirement. The test matrix:

1. **Go encrypts, TypeScript decrypts**: Go generates ciphertext with `box.Seal`, TypeScript decrypts with `crypto_box_open_easy`
2. **TypeScript encrypts, Go decrypts**: TypeScript generates ciphertext with `crypto_box_easy`, Go decrypts with `box.Open`

Both directions must pass. The test uses:
- A shared known Ed25519 seed (deterministic keypair)
- Derived X25519 keys (tested separately in Section 4)
- A known plaintext
- Random nonce (different each run, but correctness is verified by successful decryption)

**Two test approaches (from 01-CONTEXT.md):**

1. **Shared JSON test vectors**: Known keypairs, plaintexts, ciphertexts, and nonces. Both Go and TypeScript test suites independently load and verify these vectors. This validates the crypto primitives in isolation.

2. **Live cross-process integration**: Go process encrypts and writes to stdout/file, TypeScript process reads and decrypts (and vice versa). This validates the full pipeline including serialization.

Both approaches are required in CI.

### Test Vector Format

```json
{
  "vectors": [
    {
      "description": "Basic encryption roundtrip",
      "ed25519_seed_sender": "<hex>",
      "ed25519_seed_recipient": "<hex>",
      "x25519_pub_sender": "<hex>",
      "x25519_priv_sender": "<hex>",
      "x25519_pub_recipient": "<hex>",
      "x25519_priv_recipient": "<hex>",
      "nonce": "<hex, 24 bytes>",
      "plaintext": "<hex>",
      "ciphertext": "<hex, includes nonce prepended>"
    }
  ]
}
```

Generate test vectors once (from either Go or TypeScript), check them into the repo, and both test suites verify against them.

---

## 6. WebSocket Relay Server (RELY-01, RELY-03, RELY-08)

### User Decisions (from 01-CONTEXT.md)

- WebSocket library choice at Claude's discretion
- Heartbeat interval tuning within 20-30s spec

### Library: coder/websocket v1.8.14

Chosen over gorilla/websocket because:
- Native `context.Context` support throughout (clean connection lifecycle management)
- Uses no extra goroutine per connection for cancellation (2 KB memory savings per connection)
- When a deadline is hit, the connection is closed (gorilla only interrupts the blocked goroutine)
- Successor to nhooyr.io/websocket, maintained by Coder

**Key API:**
- Server: `websocket.Accept(w, r, nil)` -- accepts WebSocket upgrade
- Client: `websocket.Dial(ctx, url, nil)` -- connects to WebSocket server
- Read: `conn.Read(ctx)` -- returns message type and reader
- Write: `conn.Write(ctx, msgType, data)` -- writes a message
- Ping: `conn.Ping(ctx)` -- sends ping, waits for pong
- Close: `conn.Close(statusCode, reason)` -- clean close

### Hub-and-Spoke Architecture (RELY-03)

The hub pattern is the standard Go WebSocket architecture. A central Hub goroutine manages the routing table (address -> connection), with each client connection running independent read/write loops.

```
Hub goroutine:
  - register channel   <- new connections
  - unregister channel <- disconnected clients
  - route channel      <- messages to deliver

Per-Client:
  - readPump goroutine  (reads from WebSocket, sends to Hub)
  - writePump goroutine (reads from Hub, writes to WebSocket)
```

**Phase 1 scope**: The hub maintains a routing table mapping `pinch:` addresses to active WebSocket connections. No authentication yet (Phase 2), no message delivery yet (Phase 3). The routing table is an in-memory `map[string]*Client` behind a `sync.RWMutex` or serialized through the Hub goroutine's channels.

For Phase 1, the relay:
1. Accepts WebSocket connections
2. Registers the connection (address provided by client -- NOT yet authenticated)
3. Maintains heartbeat (ping/pong)
4. Detects disconnect and unregisters
5. Can look up a connection by address (routing table exists, but no message routing yet)

### Heartbeat / Ping-Pong (RELY-08)

**Requirement**: 20-30s interval, 5-10s pong timeout, no goroutine leaks on disconnect.

**Implementation with coder/websocket:**

The `conn.Ping(ctx)` method sends a ping and waits for a pong. The context controls the timeout. Use a ticker goroutine per connection:

```go
func (c *Client) heartbeatLoop(ctx context.Context) {
    ticker := time.NewTicker(25 * time.Second) // Within 20-30s range
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            pingCtx, cancel := context.WithTimeout(ctx, 7*time.Second) // Within 5-10s
            err := c.conn.Ping(pingCtx)
            cancel()
            if err != nil {
                // Pong timeout or connection error -- close and unregister
                c.conn.Close(websocket.StatusPolicyViolation, "heartbeat timeout")
                return
            }
        }
    }
}
```

**Goroutine leak prevention:**
- Every goroutine (readPump, writePump, heartbeat) takes a `context.Context` and exits when it's cancelled
- When the connection closes (for any reason), the context is cancelled, unblocking all goroutines
- The Hub's unregister path cancels the connection's context
- `conn.Close()` unblocks all goroutines interacting with the connection

**Monitoring**: Expose `runtime.NumGoroutine()` as a health check metric. In tests, verify goroutine count before and after connection teardown.

### Connection Lifecycle

```
1. HTTP request -> WebSocket upgrade (websocket.Accept)
2. Create Client with context derived from server context
3. Register Client in Hub (hub.register <- client)
4. Start readPump, writePump, heartbeatLoop goroutines
5. ... connection active ...
6. Disconnect detected (read error, pong timeout, or explicit close)
7. Cancel Client context (stops all goroutines)
8. Unregister Client from Hub (hub.unregister <- client)
9. Close WebSocket connection
```

### Read/Write Deadlines

Every WebSocket read and write operation should have a deadline via context:
- Read: `context.WithTimeout(ctx, 60*time.Second)` -- if no message arrives in 60s, the read times out (but heartbeat will trigger sooner)
- Write: `context.WithTimeout(ctx, 10*time.Second)` -- if a write blocks for 10s (slow consumer), close the connection

### HTTP Server

Use `go-chi/chi` v5 for the HTTP router. The relay needs:
- `GET /ws` -- WebSocket upgrade endpoint
- `GET /health` -- health check (returns goroutine count, connection count)

The WebSocket upgrade handler uses `websocket.Accept()` from coder/websocket. Chi routes the initial HTTP request; the WebSocket library handles the upgrade.

---

## 7. TypeScript WebSocket Client

### Library: ws v8.x

The `ws` package is the de facto Node.js WebSocket implementation. It provides:
- `new WebSocket(url)` -- connect to a WebSocket server
- `ws.on('message', handler)` -- receive messages
- `ws.send(data)` -- send messages
- `ws.ping()` / `ws.on('pong', handler)` -- heartbeat support
- `ws.close()` -- clean disconnection

### Client-Side Heartbeat

The TypeScript client responds to server pings automatically (ws library handles pong responses). The client can also send its own pings to detect dead connections from the client side:

```typescript
const ws = new WebSocket('ws://relay.example.com/ws');

ws.on('open', () => {
  // Start client-side heartbeat
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 25000);

  ws.on('close', () => clearInterval(interval));
});

ws.on('pong', () => {
  // Connection is alive -- reset any timeout tracking
});
```

### Connection to Relay

For Phase 1, the TypeScript client:
1. Connects to the relay WebSocket endpoint
2. Maintains the connection with heartbeat
3. Handles reconnection on disconnect (with exponential backoff)
4. No authentication yet (Phase 2)

---

## 8. Cross-Language Test Strategy

### Test Layers

**Layer 1 -- Unit tests (language-isolated):**
- Go: `go test ./...` -- test crypto functions, address generation, protobuf serialization in isolation
- TypeScript: `vitest` -- test crypto functions, address generation, protobuf serialization in isolation

**Layer 2 -- Shared test vectors (JSON):**
- A set of JSON files in a `testdata/` directory at repo root
- Both Go and TypeScript test suites load and verify against these vectors
- Covers: keypair derivation from seed, address generation, X25519 conversion, NaCl box encrypt/decrypt, protobuf round-trip

**Layer 3 -- Live cross-process integration:**
- Go encrypts a message, writes the sealed bytes to a file or stdout
- TypeScript reads the bytes and decrypts
- TypeScript encrypts, Go decrypts
- Both wrapped in a CI script that orchestrates the processes

### Shared Test Vector Generation

Generate vectors once using a trusted implementation (either Go or TypeScript -- recommend Go since `golang.org/x/crypto` is the more "reference" implementation). Check the JSON file into the repo. Both test suites verify against it.

Vector categories:
1. **Identity vectors**: seed -> Ed25519 keypair -> X25519 keypair -> address
2. **Encryption vectors**: sender keypair + recipient keypair + nonce + plaintext -> ciphertext
3. **Protobuf vectors**: known Envelope -> serialized bytes

---

## 9. Dependencies and Versions

### Go (relay/)

| Package | Version | Purpose |
|---------|---------|---------|
| `github.com/coder/websocket` | v1.8.14 | WebSocket server |
| `golang.org/x/crypto` | v0.48.0+ | nacl/box, nacl/secretbox |
| `filippo.io/edwards25519` | v1.2.0 | Ed25519 to X25519 conversion |
| `google.golang.org/protobuf` | v1.36.11 | Protobuf runtime |
| `github.com/go-chi/chi/v5` | v5.2.3 | HTTP router |
| `github.com/mr-tron/base58` | latest | Base58 encoding for addresses |
| `crypto/ed25519` | stdlib | Ed25519 signing (stdlib) |
| `crypto/ecdh` | stdlib | X25519 ECDH (stdlib) |
| `crypto/sha256` | stdlib | SHA-256 for address checksum |
| `log/slog` | stdlib | Structured logging |

**Minimum Go version:** 1.22 (required by coder/websocket context patterns)

### TypeScript (skill/)

| Package | Version | Purpose |
|---------|---------|---------|
| `libsodium-wrappers-sumo` | 0.8.0 | NaCl crypto (MUST be sumo variant) |
| `@bufbuild/protobuf` | 2.11.0 | Protobuf runtime |
| `ws` | 8.x | WebSocket client |
| `bs58` | latest | Base58 encoding for addresses |
| `typescript` | 5.x | TypeScript compiler (devDep) |
| `vitest` | latest | Test runner (devDep) |
| `@biomejs/biome` | latest | Linter/formatter (devDep) |
| `@types/ws` | latest | WebSocket types (devDep) |

### Shared Tooling

| Tool | Purpose |
|------|---------|
| `buf` CLI | Protobuf code generation, linting, breaking change detection |
| `golangci-lint` | Go linting in CI |
| GitHub Actions | CI matrix builds |

---

## 10. Pitfalls Specific to Phase 1

From PITFALLS.md, filtered to Phase 1 concerns:

### P1: Nonce Reuse (CRITICAL)

- Always use 24-byte random nonces from CSPRNG
- Never use counter-based nonces
- Prepend nonce to ciphertext
- Tests must use random nonces (no hardcoded nonces in production-path code)
- **Verification**: Encrypt same plaintext twice, verify different ciphertexts

### P2: Cross-Language Crypto Mismatch (CRITICAL)

- Write cross-language roundtrip tests BEFORE building protocol logic
- Test all operations: signing, key conversion, box seal/open
- Run in CI on every push
- Use shared test vectors AND live cross-process tests
- **Verification**: Go encrypts, TS decrypts (and vice versa) in CI

### P3: WebSocket Goroutine Leak (HIGH)

- Ping/pong heartbeats at 25s interval with 7s pong timeout
- Context-based connection lifecycle (cancel context on disconnect)
- Read/write deadlines on every operation
- Monitor `runtime.NumGoroutine()` in tests
- **Verification**: Connect 100 clients, disconnect abruptly, verify goroutine count returns to baseline

### P4: Replay Protection in Message Format (HIGH)

- Sequence numbers and timestamps inside the encrypted payload (not cleartext envelope)
- PlaintextPayload message includes `sequence` and `timestamp` fields
- Even though replay protection ENFORCEMENT is Phase 3+, the fields must exist in Phase 1's proto schema
- **Verification**: Proto schema includes both fields; serialization tests cover them

### P5: libsodium Async Init (MEDIUM)

- `await sodium.ready` before any crypto operation
- Wrap in a singleton initialization function
- Tests should verify that calling crypto before init throws a clear error
- **Verification**: Test that operations fail gracefully without `await sodium.ready`

### P6: Protocol Extensibility (MEDIUM)

- Handshake message has separate `signing_key` and `encryption_key` fields
- Envelope has a `version` field at the top level AND inside PlaintextPayload
- Use proto enum for message types (not strings) for forward compatibility
- **Verification**: Schema review confirms all extensibility fields exist

---

## 11. Success Criteria Mapping

| Success Criterion | Requirements | Key Implementation Details |
|-------------------|-------------|---------------------------|
| 1. Agent generates keypair, persists, reloads, same address | IDNT-01, IDNT-02, IDNT-03 | Ed25519 keygen via libsodium-sumo, base58 address with SHA-256 checksum, JSON key file, reload on startup |
| 2. Go relay accepts WS, TypeScript connects, heartbeat works | RELY-01, RELY-08 | coder/websocket v1.8.14, hub pattern, 25s ping interval / 7s pong timeout, context-based lifecycle |
| 3. Protobuf message serializes cross-language | PROT-01, PROT-02, PROT-03, PROT-04 | buf code generation, Envelope with version + oneof, PlaintextPayload with sequence + timestamp |
| 4. NaCl box roundtrip Go <-> TypeScript | CRYP-02, CRYP-03, CRYP-04 | Ed25519->X25519 conversion, random 24-byte nonces, shared test vectors + live cross-process tests |
| 5. Relay routing table maps addresses to connections | RELY-03 | Hub maintains `map[string]*Client`, register/unregister on connect/disconnect |

---

## 12. Open Questions for Planning

These do not require additional research but should be decided during plan creation:

1. **Go module path**: What organization name for `go mod init`? (e.g., `github.com/pinch-protocol/pinch/relay`)
2. **gen/ directory packaging**: Should `gen/go` be a separate Go module (with its own go.mod) or handled via go.work? Go.work is simpler for development but gen/go as a module is cleaner for imports.
3. **Key file location**: Default `~/.pinch/identity.json` or configurable via environment variable? (Recommend: env var `PINCH_IDENTITY_PATH` with default fallback)
4. **Test vector generation**: Generate once from Go or TypeScript? (Recommend: Go, since `golang.org/x/crypto` is the more canonical NaCl implementation)
5. **CI matrix**: GitHub Actions runners -- ubuntu-latest with Go 1.22+ and Node.js 20+ LTS?
6. **Biome config**: What rules to enable? (Recommend: default recommended preset)

---

## 13. Sources

### Library Documentation (HIGH confidence)
- [coder/websocket GitHub](https://github.com/coder/websocket) -- v1.8.14 API, context support, ping/pong
- [coder/websocket Go docs](https://pkg.go.dev/github.com/coder/websocket) -- full API reference
- [golang.org/x/crypto/nacl/box](https://pkg.go.dev/golang.org/x/crypto/nacl/box) -- Seal, Open, GenerateKey signatures
- [golang.org/x/crypto/nacl/box example](https://github.com/golang/crypto/blob/master/nacl/box/example_test.go) -- official Go example
- [filippo.io/edwards25519](https://pkg.go.dev/filippo.io/edwards25519) -- BytesMontgomery for Ed25519->X25519
- [crypto/ed25519](https://pkg.go.dev/crypto/ed25519) -- stdlib Ed25519
- [crypto/ecdh](https://pkg.go.dev/crypto/ecdh) -- stdlib X25519 ECDH
- [libsodium-wrappers-sumo npm](https://www.npmjs.com/package/libsodium-wrappers-sumo) -- v0.8.0, sumo variant
- [libsodium Ed25519 to Curve25519 docs](https://libsodium.gitbook.io/doc/advanced/ed25519-curve25519) -- conversion functions
- [@bufbuild/protobuf npm](https://www.npmjs.com/package/@bufbuild/protobuf) -- v2.11.0, conformance tests
- [protobuf-es GitHub](https://github.com/bufbuild/protobuf-es) -- TypeScript protobuf
- [buf.gen.yaml v2 docs](https://buf.build/docs/configuration/v2/buf-gen-yaml/) -- code generation config
- [buf code generation quickstart](https://buf.build/docs/generate/tutorial/) -- setup tutorial
- [protobuf language guide (proto3)](https://protobuf.dev/programming-guides/proto3/) -- oneof, enums, field numbering
- [ws npm package](https://www.npmjs.com/package/ws) -- Node.js WebSocket client
- [pnpm workspaces](https://pnpm.io/workspaces) -- workspace protocol
- [go-chi/chi GitHub](https://github.com/go-chi/chi) -- HTTP router

### Architecture Patterns (HIGH confidence)
- [Filippo Valsorda: Using Ed25519 keys for encryption](https://words.filippo.io/using-ed25519-keys-for-encryption/) -- key conversion rationale
- [ssh-to-age convert.go](https://github.com/Mic92/ssh-to-age/blob/main/convert.go) -- working Ed25519->X25519 Go code
- [Go proposal: Ed25519 to Curve25519 conversion](https://github.com/golang/go/issues/20504) -- background on why this is not in stdlib
- [NaCl crypto_box documentation](https://nacl.cr.yp.to/box.html) -- canonical NaCl reference

### Security References (HIGH confidence)
- [Thormarker (2021): On using the same key pair for Ed25519 and X25519](https://eprint.iacr.org/2021/509.pdf) -- key reuse analysis
- [Signal Protocol Documentation](https://signal.org/docs/) -- store-and-forward encryption patterns
- [gorilla/websocket goroutine leak issues](https://github.com/gorilla/websocket/issues/134) -- WebSocket memory pitfalls
- [Finding and Fixing a 50,000 Goroutine Leak](https://skoredin.pro/blog/golang/goroutine-leak-debugging) -- goroutine leak patterns

---

*Phase 1 research completed: 2026-02-26*
*Confidence: HIGH -- all technologies are well-documented with verified library versions*
*Ready for planning: yes*
