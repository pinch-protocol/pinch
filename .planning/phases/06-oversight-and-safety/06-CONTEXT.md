# Phase 6: Oversight and Safety - Context

**Gathered:** 2026-02-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Human visibility and control over agent communication, plus system protection. Delivers: activity feed with filtering, human intervention in conversations, tamper-evident audit log, relay rate limiting, and connection muting. The activity feed surfaces through OpenClaw skill tools — agents consume structured data and synthesize natural-language summaries for humans via Telegram/WhatsApp.

</domain>

<decisions>
## Implementation Decisions

### Activity Feed & Filtering
- Compact one-liner entries in a unified event log (single append-only table for all event types)
- The agent consumes structured entries and composes natural-language summaries for the human — the feed is not human-facing directly
- Everything generates feed entries: messages sent/received, connection requests, approvals, rejections, blocks, revokes, autonomy changes, permission updates
- Filterable by: connection (specific or all), time range (since timestamp), event type (messages, connections, autonomy changes)
- A `pinch_activity` skill tool queries the unified event log with filter parameters

### Human Intervention Flow
- Inline command model: human tells their agent "I'll handle this one" and the agent switches to passthrough mode for that connection
- During passthrough: agent still receives incoming messages from that connection, surfaces them to the human, and can add context ("Jake's agent is responding to your dinner question")
- Human's replies are sent as Pinch messages with human attribution
- Explicit handback to end intervention: human says "you take it from here" or equivalent
- Visible attribution on the receiving end — messages carry an agent-sent or human-sent flag so the other side knows who they're talking to

### Audit Log & Integrity
- Same store as the unified event log — hash chaining is added to the event log entries, not a separate store
- SHA-256 hash chaining: each entry includes a hash of itself + the previous entry's hash
- Grows indefinitely — no retention policy, no purging
- Verification via skill tool (`pinch_audit_verify`) for quick checks: walks the hash chain and reports pass/fail
- Verification via export: dump log to JSON file, standalone script verifies hash chain independently — doesn't rely on the agent
- Audit log entries include: timestamp, actor pubkey, action type, connection ID, message hash (per OVRS-06)

### Rate Limiting
- Relay-side (Go) per-connection rate limiting
- Generous defaults — agents can be chatty; only catch obvious abuse (e.g., 60 messages/minute, 1000/hour range)
- On rate limit: sender receives an error with retry-after duration — clear, actionable feedback
- Token bucket or sliding window algorithm (Claude's discretion on which)

### Muting
- Silent mute — sender has no idea they've been muted; messages appear to deliver normally (delivery confirmations still sent)
- Muted messages are still recorded in the audit log for completeness, but not surfaced in the activity feed or to the agent/human
- Muting is a local decision — no notification to the other side

### Claude's Discretion
- Token bucket vs sliding window algorithm choice for rate limiting
- Exact rate limit default values (within the "generous" range)
- Internal schema design for the unified event log
- How passthrough mode is tracked internally (connection state, timeout safeguards)
- Export format details for audit log verification

</decisions>

<specifics>
## Specific Ideas

- Activity feed is consumed by agents, not humans directly. The agent synthesizes summaries like: "Here's your Pinch activity today: Matt's agent — finalized equity terms, awaiting your confirmation. Sarah's agent — booked dinner at Masu, Saturday 7pm."
- The underlying data is structured (for `pinch_history` and `pinch_activity` queries), but what reaches the human is a natural-language summary the agent composes
- Human intervention should feel natural in the Telegram/WhatsApp context — not like invoking a formal tool, but like telling your agent to step aside

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-oversight-and-safety*
*Context gathered: 2026-02-27*
