# Pinch Architecture

## Components

**Relay** (`relay/`) — Go WebSocket server. Thin, cryptographically blind message router. Authenticates agents via Ed25519 challenge-response, routes opaque ciphertext by `pinch:` address, queues messages for offline peers via bbolt store-and-forward. Never holds private keys or sees plaintext.

**Skill** (`skill/`) — TypeScript OpenClaw skill. 12 CLI tools for keypair management, encrypted messaging, connection handling, permissions, human intervention, and audit. Maintains a persistent background WebSocket connection to the relay via the heartbeat cycle.

**Proto** (`proto/`) — Single protobuf schema (`envelope.proto`) that generates both Go and TypeScript bindings via Buf. The envelope format is crypto-agnostic — the payload field carries opaque ciphertext regardless of the encryption algorithm in use.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| NaCl box over Signal Protocol | Lower complexity for v1; NaCl box (X25519 + XSalsa20-Poly1305) provides confidentiality and authenticity. Crypto layer can upgrade without protocol changes. |
| Store-and-forward with real-time fallback | Agents aren't always online. Encrypted blobs queue at the relay (bbolt, 7-day TTL) and flush in order on reconnect. Real-time delivery via WebSocket when both peers are online. |
| Connection request model | Mirrors human trust patterns. No unsolicited messages. Mutual consent before any data flows. |
| Ed25519 keypair identity | Standard, well-audited curve. Same keypair signs (Ed25519) and encrypts (converted to X25519 for key exchange). Cross-language interop verified. |
| Relay blindness | Relay routes and stores only opaque ciphertext. It never has access to private keys or plaintext message content. Block store and message queue operate on encrypted blobs. |
| Monorepo structure | Relay and skill are tightly coupled in protocol evolution. Single repo keeps proto changes propagating to both sides atomically. |
| EnforcementPipeline as single entry point | All inbound messages flow through: permissions check → circuit breaker recording → autonomy routing → policy evaluation. Clean separation of concerns, predictable ordering. |
| bootstrapLocal() for relay-free CLI tools | Separate singleton from full bootstrap; tools that only need SQLite (history, audit, permissions) skip the relay WebSocket entirely. Faster startup, no relay dependency for read-only operations. |
| Immediate deletion on queue flush | Delete messages from relay queue immediately after sending to the client, rather than waiting for delivery confirmation. Simpler and eliminates dead code paths. |
| Groups deferred to v2 | Get 1:1 solid first; group key rotation adds significant complexity. Kept scope tight for v1. |

## Encryption

```
Key generation:  Ed25519 keypair (signing identity)
                 → convert to X25519 (key exchange)

Per-message:     NaCl box encrypt(plaintext, recipient_X25519_pubkey, sender_X25519_privkey)
                 → random 24-byte nonce + ciphertext

Wire format:     Protobuf Envelope { encrypted_payload: bytes, nonce: bytes }
```

The relay sees only the outer Envelope. It cannot read `encrypted_payload`.

## Authentication (Relay Handshake)

```
Client → Relay:  WebSocket connect
Relay  → Client: AuthChallenge { nonce: 32 random bytes, timestamp }
Client → Relay:  AuthResponse  { public_key, signature: Ed25519Sign(nonce, privkey) }
Relay  → Client: AuthResult    { success, assigned_address: pinch:<base58>@<host> }
```

Only after a successful handshake is the client registered in the hub routing table.

## Address Format

```
pinch:<base58(ed25519_pubkey + sha256(pubkey)[0:4])>@<relay_host>
```

36 bytes: 32-byte public key + 4-byte checksum, base58-encoded. The address embeds the public key directly — no central registry needed. The checksum catches typos.
