# Phase 1: Foundation and Crypto Primitives - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Working monorepo where Go relay accepts WebSocket connections, TypeScript skill connects, Ed25519 keypairs generate addresses, protobuf messages serialize cross-language, and crypto roundtrip tests pass in CI. No authentication, no message delivery logic, no connection management — those are later phases.

</domain>

<decisions>
## Implementation Decisions

### Monorepo layout
- Claude's discretion on top-level folder structure (relay/, skill/, proto/ or similar)
- pnpm for TypeScript package management with workspaces
- buf for protobuf code generation (Go + TypeScript from single buf.yaml)
- Go module scoped to relay/ directory (go.mod inside relay/, not at repo root)

### Address format
- Full 32-byte Ed25519 public key encoded in base58 (no truncation, no hashing)
- 4-byte checksum appended: first 4 bytes of SHA-256(pubkey) included in the base58 encoding
- Relay identifier is hostname only: `pinch:<base58_pubkey_with_checksum>@relay.example.com`
- No port in address — use DNS/standard ports

### Proto envelope design
- Outer + inner envelope structure: outer (unencrypted) has routing/metadata, inner is encrypted ciphertext blob
- Relay reads outer envelope for routing, never sees inner payload
- Proto enum for message types (HANDSHAKE, AUTH_CHALLENGE, AUTH_RESPONSE, MESSAGE, DELIVERY_CONFIRM, CONNECTION_REQUEST, etc.)
- Versioned proto namespace: `package pinch.v1`
- Single Envelope message with `oneof` payload field containing all message type variants

### Dev tooling & CI
- GitHub Actions for CI with matrix builds (Go + TypeScript)
- Cross-language crypto tests use both approaches:
  - Shared JSON test vectors (known keypairs, plaintexts, ciphertexts, nonces) loaded by both Go and TS test suites independently
  - Live cross-process integration: Go encrypts → TS decrypts and vice versa in CI
- Go: standard library `testing` package (no framework)
- TypeScript: vitest as test runner
- Linting enforced from day one: golangci-lint (Go) + Biome (TypeScript) in CI

### Claude's Discretion
- Exact folder structure and naming conventions within the monorepo
- buf.yaml and buf.gen.yaml configuration details
- WebSocket library choice for Go relay and TypeScript skill
- Exact proto field names and numbering
- Heartbeat interval tuning (within the 20-30s spec from requirements)
- Key storage format and location for persisted Ed25519 keypairs

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation-and-crypto-primitives*
*Context gathered: 2026-02-26*
