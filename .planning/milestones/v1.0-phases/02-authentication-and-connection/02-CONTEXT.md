# Phase 2: Authentication and Connection - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents authenticate to the relay via Ed25519 challenge-response and establish mutual-consent connections with each other. Connections can be blocked (relay-enforced) or revoked. Baseline autonomy levels (Full Manual and Full Auto) are configurable per connection. Encrypted messaging, store-and-forward, and graduated autonomy (Notify, Auto-respond) are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Connection request experience
- Connection requests carry the sender's `pinch:` address plus a free-text short message (e.g., "Hey, it's Alice's research agent")
- Incoming requests surface in the agent's activity feed as an event
- Rejected requests result in silent rejection — sender receives no feedback and cannot infer whether the recipient exists
- Pending requests expire after a configurable TTL (Claude picks a sensible default, e.g., 7 days)

### Block & revoke behavior
- Blocking results in silent drop — relay discards messages from the blocked pubkey with no indication to the sender
- Revoking sends a "connection ended" signal to the other party before severing — the revoked agent knows the connection was terminated
- After a revoke, either party can immediately send a new connection request to reconnect
- This distinction (block = silent, revoke = notified) lets agents differentiate between "you're gone" and "you're invisible"

### Autonomy switching
- Upgrading from Full Manual to Full Auto requires a confirmation step with a clear warning ("This agent will process messages without your approval")
- Full Auto is available immediately on any connection — no trust-building period required. The human is trusted to make the call
- In Full Manual mode, queued inbound messages are presented one at a time for individual approve/reject
- Downgrading from Full Auto to Full Manual takes effect immediately — the very next inbound message is queued for human approval

### Connection identity & naming
- Connections support user-assigned nicknames that are local-only (the other agent doesn't see them)
- A contacts list shows all connections with four states: Active, Pending, Blocked, Revoked — nothing disappears from view
- Each contact entry shows: nickname, pinch address, state, last activity
- Autonomy level (Full Manual / Full Auto) is shown subtly as secondary info on each contact — visible when you look, not the primary focus

### Claude's Discretion
- Whether blocking is reversible (unblock restores connection) or permanent (must re-request) — pick based on security tradeoffs
- Exact TTL default for pending connection requests
- Connection request message length limits
- Contacts list sorting and filtering behavior
- Challenge-response protocol details (nonce size, timeout)

</decisions>

<specifics>
## Specific Ideas

- Block vs revoke distinction is deliberate: blocking is a privacy/security action (silent), revoking is a social action (notified)
- The one-at-a-time message approval in Full Manual is intentional — forces the human to engage with each message individually rather than bulk-approving

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-authentication-and-connection*
*Context gathered: 2026-02-26*
