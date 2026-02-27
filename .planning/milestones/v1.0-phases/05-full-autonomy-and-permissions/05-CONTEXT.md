# Phase 5: Full Autonomy and Permissions - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the 4-tier autonomy state machine (Full Manual / Notify / Auto-respond / Full Auto) enforced at the agent level, an inbound permissions manifest controlling what each connection can send, human controls for changing autonomy levels, and circuit breakers for auto-downgrade. The autonomy levels were defined in Phase 2 (AUTO-01, AUTO-02) but the actual enforcement behaviors are built here.

</domain>

<decisions>
## Implementation Decisions

### Autonomy tier behaviors
- **Full Manual**: Queue every inbound message for human approval. Queue indefinitely — no TTL, no auto-reject. Messages sit until the human acts.
- **Notify**: Agent processes messages autonomously. Actions appear in the activity feed with a "processed autonomously" badge. No push notifications — human sees it when they check the feed.
- **Auto-respond**: Agent handles messages according to a natural language policy written by the human (e.g., "respond to scheduling requests, reject file transfers"). The LLM interprets the policy per-message. Flexible but the human accepts the interpretive nature.
- **Full Auto**: Agent operates independently. The permissions manifest IS the guardrail — no extra limits beyond what the manifest allows plus circuit breakers. Everything logged to audit trail.

### Permissions manifest design
- **Deny-by-default**: Nothing gets through unless explicitly allowed in the manifest. New message types are blocked until the human permits them.
- **Domain-specific capability tiers** (fixed core set):
  - Calendar: none / free-busy only / full details / propose & book
  - Files: none / specific folders / everything
  - Actions: whether the other agent can request your agent to do things on your behalf (yes/no or scoped)
  - Spending: dollar cap per transaction, per day, per connection
  - Information boundaries: explicit exclusions defined in natural language (e.g., "never share my financials, health info, or other business relationships")
- **Fixed core + optional custom categories**: Core categories are enforced structurally. Humans can add custom categories that are LLM-interpreted (similar to information boundaries).
- **Uncertain boundary handling**: When the LLM is uncertain whether content violates an information boundary, block the message and escalate to the human for a decision.

### Circuit breaker triggers
- **Triggers** (all four active):
  - Message flood: unusually high volume in a short window
  - Permission violations: repeated attempts to send denied message types
  - Spending cap exceeded: actions that would push past configured dollar caps
  - Boundary probing: repeated messages that trigger information boundary uncertainty
- **Downgrade behavior**: Straight to Full Manual on any circuit breaker trigger. No gradual step-down.
- **Recovery**: Human must manually re-upgrade. No automatic recovery, no cooldown-based restoration.
- **Notification**: Circuit breaker event appears in the activity feed with trigger details, plus the connection gets a warning badge so it stands out.

### Autonomy change controls
- **Timing**: Changes take effect immediately — applies to the very next inbound message. Messages already being processed complete under the old level.
- **Peer notification**: The peer agent is NOT notified of autonomy level changes. They may observe behavior changes (e.g., slower responses) but Pinch doesn't reveal your trust configuration.
- **Agent suggestions**: The agent can suggest autonomy changes (surfaced in activity feed) but the human must approve. No self-upgrade.
- **No restrictions**: Human can set any autonomy level at any time, including Full Auto on a brand-new connection. Human is the boss.

### Claude's Discretion
- Exact threshold values for circuit breaker triggers (message flood rate, violation count before trip)
- How the natural language policy is stored and passed to the LLM for Auto-respond evaluation
- Internal representation of the permissions manifest (JSON schema, protobuf, etc.)
- How "processed autonomously" badge surfaces in the activity feed data model

</decisions>

<specifics>
## Specific Ideas

- Permissions should feel like real-world trust gradients: "I trust you with my calendar but not my files" — not binary allow/deny
- Information boundaries are the most novel part — natural language exclusions like "never share my financials, health info, or other business relationships" interpreted by the LLM per-message
- The human writes a natural language policy for Auto-respond — this is like giving instructions to an assistant, not programming rules
- Circuit breakers should feel protective, not punitive — the warning badge on a connection helps the human understand what happened

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-full-autonomy-and-permissions*
*Context gathered: 2026-02-26*
