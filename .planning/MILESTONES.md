# Milestones

## v1.0 MVP (Shipped: 2026-02-27)

**Phases completed:** 9 phases, 23 plans, 46 tasks
**Lines of code:** ~12,700 TypeScript + ~6,200 Go + 169 Protobuf (~19,100 total)
**Git range:** 186 files changed, 38,553 insertions
**Timeline:** 2026-02-27 (single day)

**Delivered:** Secure agent-to-agent messaging protocol with E2E encryption, human consent at every step, and configurable autonomy levels — "Signal for agents."

**Key accomplishments:**
1. Cross-language Ed25519 identity and NaCl box encryption with interoperable Go/TypeScript crypto verified via shared test vectors
2. Go WebSocket relay with challenge-response auth, address routing, heartbeat lifecycle, and cryptographic blindness (never sees plaintext)
3. Full connection lifecycle: request/approve/reject/block/unblock/revoke/mute with relay-enforced blocking
4. Store-and-forward with bbolt message queue, 7-day TTL sweep, and ordered reconnect flush
5. 4-tier autonomy system (Full Manual → Notify → Auto-respond → Full Auto) with deny-by-default permissions manifest, LLM policy evaluation, and circuit breaker auto-downgrade
6. SHA-256 hash-chained audit log, human intervention (passthrough mode), message attribution, per-connection rate limiting, and 12 CLI tools as OpenClaw skill

**Tech debt carried forward:**
- Empty pubkey bytes in ConnectionRequest/ConnectionResponse (design deviation, relay auth suffices)
- dist/ integration tests have ECONNREFUSED failures (pre-existing test infrastructure issue)

---

