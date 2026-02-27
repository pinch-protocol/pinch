# Phase 3: Encrypted 1:1 Messaging - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Two agents exchange end-to-end encrypted messages through the relay in real time, with the relay seeing only ciphertext. Integrated as an OpenClaw skill with five outbound tools. Inbound messages route based on connection autonomy level (Full Manual and Full Auto only in this phase). Store-and-forward for offline agents is Phase 4. Full autonomy spectrum (Notify, Auto-respond) is Phase 5.

</domain>

<decisions>
## Implementation Decisions

### Skill tool surface
- Five tools: `pinch_send`, `pinch_connect`, `pinch_contacts`, `pinch_history`, `pinch_status`
- `pinch_send` — core params: recipient (pinch address), body (text). Optional: thread_id, reply_to (message_id), priority (low/normal/urgent)
- `pinch_connect` — send connection requests to a pinch address. Lifecycle tool for requesting new connections
- `pinch_contacts` — list and query existing connections (status, autonomy level, labels)
- `pinch_history` — two modes: per-connection (filter by connection + optional thread_id) and global inbox (across all connections). Paginated
- `pinch_status` — check delivery state of a sent message by message_id
- Returns immediately with message_id on send (fire-and-forget)

### Message content model
- Text only — plain text messages, no structured payloads or attachments in v1
- 64KB message size limit enforced at relay level
- Full context envelope accompanies each message: sender address, timestamp, connection name/label, thread_id, reply_to, priority, sequence number
- Messages persisted locally on the agent side (disk storage) — survives restarts, powers pinch_history

### Delivery confirmations
- Always automatic — every delivered message triggers a signed confirmation
- Fire-and-forget sending: pinch_send returns instantly with message_id, agent checks via pinch_status when needed
- Six delivery states: Sent → Relayed → Delivered → Read-by-agent → Escalated-to-human, plus Failed (with reason)
- 30-second relay buffer for transient disconnects before marking as failed (Phase 4 adds real store-and-forward)

### Inbound message flow
- Full Manual: messages appear as pending items in the OpenClaw activity feed for human review
- Human approves each message and chooses per-message: "let agent handle it" or "I'll respond myself"
- Full Auto: messages pushed to agent in real-time via persistent WebSocket (not heartbeat polling)
- Agent decides whether to reply — message is presented to LLM with full context, agent has pinch_send available but no forced acknowledgment

### Claude's Discretion
- SKILL.md YAML frontmatter structure and markdown body layout
- Exact WebSocket heartbeat/reconnection strategy
- Local message store format (JSON file, SQLite, etc.)
- Error message wording and error code taxonomy
- Exact protobuf message schema for encrypted payloads
- How thread_id is generated (UUID, human-readable, etc.)

</decisions>

<specifics>
## Specific Ideas

- "thread_id is essential once a conversation has multiple topics going — without it, everything is one giant stream and agents can't track parallel threads"
- "reply_to lets agents maintain conversational context — otherwise long conversations lose coherence"
- "priority lets the receiving agent decide whether to interrupt its human or batch into the next digest"
- "pinch_send should return instantly — if the recipient is offline, blocking on a timeout means your agent can't do other work"
- "pinch_status is a simple status check — easy to implement, easy to reason about, covers every use case without async event routing complexity"
- Delivery state chain gives sending agent real visibility: the sender can see not just "delivered" but whether the recipient's agent processed it or escalated to a human

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-encrypted-1-1-messaging*
*Context gathered: 2026-02-26*
