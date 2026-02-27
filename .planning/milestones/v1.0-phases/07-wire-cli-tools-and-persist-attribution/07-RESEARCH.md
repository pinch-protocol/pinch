# Phase 7: Wire Phase 6 CLI Tools and Persist Attribution - Research

**Researched:** 2026-02-27
**Domain:** CLI tool wiring (package.json bin entries) and SQLite schema evolution (attribution column)
**Confidence:** HIGH

## Summary

Phase 7 is a gap-closure phase with two well-scoped, low-risk workstreams. The first adds five missing bin entries to `skill/package.json` so that Phase 6 CLI tools (pinch-activity, pinch-intervene, pinch-mute, pinch-audit-verify, pinch-audit-export) become invocable after `pnpm install`. The second persists inbound message attribution (`"agent"` or `"human"`) to the messages SQLite table and surfaces it through `pinch-history`.

All five CLI tools already exist as fully-implemented TypeScript files in `skill/src/tools/` with self-executable entry points, argument parsing, tests, and documentation in SKILL.md. The attribution data is already extracted during `handleIncomingMessage()` (line 217-227 of `message-manager.ts`) but is discarded after use -- it is not persisted to the SQLite `messages` table. Outbound attribution is already passed via `SendMessageParams.attribution` and encoded in the `application/x-pinch+json` wrapper.

**Primary recommendation:** This phase requires zero new modules, zero new dependencies, and minimal code changes. It is purely wiring and schema evolution work. One plan is sufficient.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OVRS-01 | Human can view activity feed of sent/received messages and connection events | pinch-activity tool exists, needs bin entry in package.json |
| OVRS-02 | Activity feed filterable by connection, time range, message type | pinch-activity already supports --connection, --since, --until, --type flags; needs bin entry |
| OVRS-03 | Human can intervene in any conversation -- take over and send messages directly | pinch-intervene tool exists with --start/--stop/--send modes; needs bin entry |
| OVRS-04 | Messages attributed as agent-sent or human-sent for conversation clarity | Outbound attribution works via `SendMessageParams.attribution`; inbound attribution is extracted in `handleIncomingMessage()` but NOT persisted to messages table; `pinch-history` does not surface attribution field |
| OVRS-05 | Tamper-evident audit log with hash chaining | pinch-audit-verify and pinch-audit-export tools exist; need bin entries |
| CONN-05 | Agent can mute a connection | pinch-mute tool exists with --connection/--unmute flags; needs bin entry; enforcement pipeline already handles mute check |
</phase_requirements>

## Standard Stack

### Core

No new libraries needed. Phase 7 uses only what is already installed.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | SQLite schema evolution (ALTER TABLE ADD COLUMN) | Already used by MessageStore and ActivityFeed |
| vitest | latest | Test runner for new tests | Already used across all existing tests |

### Supporting

None needed. All dependencies are already in the project.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ALTER TABLE ADD COLUMN | Separate attribution table | Overkill for a single nullable TEXT column; joins add complexity for no benefit |
| Runtime schema migration | Migration framework (e.g., umzug, knex) | Far too heavy for a single column addition; the existing PRAGMA table_info + ALTER TABLE pattern in ActivityFeed is proven and consistent |

**Installation:**
```bash
# No new packages needed
```

## Architecture Patterns

### Recommended Project Structure

No new files or directories. Changes are in-place to existing files:
```
skill/
  package.json            # Add 5 bin entries
  src/
    message-store.ts      # ALTER TABLE ADD COLUMN attribution; update rowToRecord, saveMessage
    message-manager.ts    # Persist inboundAttribution in handleIncomingMessage()
    tools/
      pinch-history.ts    # Include attribution in output mapping
```

### Pattern 1: Schema Evolution via PRAGMA table_info (Existing Pattern)

**What:** Check if column exists before adding it via ALTER TABLE, avoiding errors on existing databases.
**When to use:** Adding a column to an existing SQLite table without a migration framework.
**Confidence:** HIGH -- this exact pattern is already used in `activity-feed.ts` lines 94-131.

**Example from existing codebase (activity-feed.ts):**
```typescript
// Evolve schema: add column if it does not exist.
const columns = this.db
    .prepare("PRAGMA table_info(activity_events)")
    .all() as { name: string }[];
const columnNames = new Set(columns.map((c) => c.name));

if (!columnNames.has("actor_pubkey")) {
    this.db.exec(
        "ALTER TABLE activity_events ADD COLUMN actor_pubkey TEXT",
    );
}
```

**For Phase 7 -- apply to messages table in initSchema():**
```typescript
// After CREATE TABLE IF NOT EXISTS messages...
const columns = this.db
    .prepare("PRAGMA table_info(messages)")
    .all() as { name: string }[];
const columnNames = new Set(columns.map((c) => c.name));

if (!columnNames.has("attribution")) {
    this.db.exec(
        "ALTER TABLE messages ADD COLUMN attribution TEXT",
    );
}
```

### Pattern 2: package.json bin Entry (Existing Pattern)

**What:** Map CLI command names to compiled JavaScript entry points in the `dist/` output directory.
**When to use:** Making TypeScript CLI tools invocable as commands after `pnpm install`.
**Confidence:** HIGH -- 7 tools already follow this exact pattern.

**Existing pattern (package.json):**
```json
{
  "bin": {
    "pinch-send": "./dist/tools/pinch-send.js",
    "pinch-connect": "./dist/tools/pinch-connect.js",
    "pinch-contacts": "./dist/tools/pinch-contacts.js",
    "pinch-history": "./dist/tools/pinch-history.js",
    "pinch-status": "./dist/tools/pinch-status.js",
    "pinch-autonomy": "./dist/tools/pinch-autonomy.js",
    "pinch-permissions": "./dist/tools/pinch-permissions.js"
  }
}
```

**Add 5 new entries:**
```json
{
  "pinch-activity": "./dist/tools/pinch-activity.js",
  "pinch-intervene": "./dist/tools/pinch-intervene.js",
  "pinch-mute": "./dist/tools/pinch-mute.js",
  "pinch-audit-verify": "./dist/tools/pinch-audit-verify.js",
  "pinch-audit-export": "./dist/tools/pinch-audit-export.js"
}
```

### Pattern 3: Attribution Through the Message Lifecycle

**What:** Track whether a message was sent by an agent or a human at every stage.
**Confidence:** HIGH -- based on direct codebase inspection.

**Current flow (outbound):**
1. `pinch-intervene --send` passes `attribution: "human"` to `messageManager.sendMessage()`
2. `sendMessage()` wraps body in `{ text, attribution }` JSON with content type `application/x-pinch+json`
3. Outbound messages are saved to SQLite WITHOUT the attribution field (gap)

**Current flow (inbound):**
1. `handleIncomingMessage()` detects `application/x-pinch+json` content type
2. Parses `{ text, attribution }` from the JSON wrapper
3. Extracts `body` and `inboundAttribution` (line 217-227)
4. Saves `messageRecord` to SQLite WITHOUT the `inboundAttribution` value (gap)

**Fix:** Save attribution in both paths:
- In `handleIncomingMessage()`: add `attribution: inboundAttribution` to the `messageRecord` before `saveMessage()`
- In `sendMessage()`: add `attribution` to the outbound `saveMessage()` call
- In `MessageRecord` interface: add `attribution?: "agent" | "human"`
- In `MessageStore.saveMessage()`: include `attribution` in INSERT
- In `MessageStore.rowToRecord()`: map `attribution` column

### Anti-Patterns to Avoid
- **Breaking existing databases:** Never use DROP TABLE + CREATE TABLE. Always use ALTER TABLE ADD COLUMN with a PRAGMA table_info guard for backward compatibility.
- **Mandatory attribution column:** Use `TEXT` (nullable) not `TEXT NOT NULL` -- existing messages have no attribution and should remain valid.
- **Modifying hash chain data:** The attribution column is on the `messages` table, NOT the `activity_events` table. The hash chain is unaffected.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema migration | Migration framework or version tracking | PRAGMA table_info + ALTER TABLE (existing pattern) | Single column addition -- migration framework is overkill |
| CLI argument parsing | Custom option parser | Existing parseArgs pattern (already in all tools) | Consistency -- all tools already use the same hand-rolled parser |

**Key insight:** This phase has no deceptively complex problems. All work follows well-established patterns already in the codebase.

## Common Pitfalls

### Pitfall 1: Missing `tsc` Build Before Testing bin Entries
**What goes wrong:** Adding bin entries to package.json but forgetting to run `tsc` (or `pnpm build`) so the `dist/tools/` files do not exist.
**Why it happens:** The bin entries point to `./dist/tools/*.js`, which are compiled output -- they do not exist until TypeScript compiles.
**How to avoid:** Run `pnpm --filter @pinch/skill build` before testing bin invocability.
**Warning signs:** `command not found` or `ENOENT` when running the CLI tool name.

### Pitfall 2: ALTER TABLE on a Column That Already Exists
**What goes wrong:** SQLite throws `duplicate column name: attribution` if the migration runs twice.
**Why it happens:** `initSchema()` runs on every `MessageStore` construction -- multiple runs must be idempotent.
**How to avoid:** Always guard with PRAGMA table_info check (existing pattern in ActivityFeed).
**Warning signs:** Crash on second `MessageStore` instantiation with same database.

### Pitfall 3: Forgetting to Map Attribution in rowToRecord
**What goes wrong:** Attribution column exists in SQLite but `getHistory()` and `getMessage()` return `undefined` for attribution.
**Why it happens:** `rowToRecord()` manually maps each column -- new columns must be explicitly added.
**How to avoid:** Update `rowToRecord()` to include `attribution: (row.attribution as string) ?? undefined`.
**Warning signs:** `pinch-history` output shows all messages without attribution.

### Pitfall 4: Breaking Existing Tests by Changing MessageRecord Interface
**What goes wrong:** Adding a required field to `MessageRecord` breaks all test helpers that construct records.
**Why it happens:** The `makeMessage()` test helper creates `MessageRecord` objects -- a new required field would need a default.
**How to avoid:** Make `attribution` optional (`attribution?: "agent" | "human"`) -- it is genuinely optional (old messages have none).
**Warning signs:** Compilation errors across test files.

### Pitfall 5: Not Persisting Outbound Attribution
**What goes wrong:** Only inbound messages get attribution persisted. Outbound messages sent via `pinch-intervene --send` (human attribution) lose their attribution in SQLite.
**Why it happens:** The `sendMessage()` method saves the message record but currently does not include `attribution` in the `saveMessage()` call.
**How to avoid:** Pass `attribution: params.attribution ?? "agent"` in the outbound `saveMessage()` call.
**Warning signs:** `pinch-history` shows attribution for inbound messages but not outbound.

## Code Examples

### Example 1: Adding bin Entries to package.json

```json
{
  "bin": {
    "pinch-send": "./dist/tools/pinch-send.js",
    "pinch-connect": "./dist/tools/pinch-connect.js",
    "pinch-contacts": "./dist/tools/pinch-contacts.js",
    "pinch-history": "./dist/tools/pinch-history.js",
    "pinch-status": "./dist/tools/pinch-status.js",
    "pinch-autonomy": "./dist/tools/pinch-autonomy.js",
    "pinch-permissions": "./dist/tools/pinch-permissions.js",
    "pinch-activity": "./dist/tools/pinch-activity.js",
    "pinch-intervene": "./dist/tools/pinch-intervene.js",
    "pinch-mute": "./dist/tools/pinch-mute.js",
    "pinch-audit-verify": "./dist/tools/pinch-audit-verify.js",
    "pinch-audit-export": "./dist/tools/pinch-audit-export.js"
  }
}
```

### Example 2: MessageRecord Interface Update

```typescript
export interface MessageRecord {
    id: string;
    connectionAddress: string;
    direction: "inbound" | "outbound";
    body: string;
    threadId?: string;
    replyTo?: string;
    priority: "low" | "normal" | "urgent";
    sequence: number;
    state: string;
    failureReason?: string;
    attribution?: "agent" | "human";  // NEW
    createdAt: string;
    updatedAt: string;
}
```

### Example 3: Schema Evolution in MessageStore.initSchema()

```typescript
private initSchema(): void {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            -- ... existing columns ...
        );
        -- ... existing indexes ...
    `);

    // Evolve schema: add attribution column if not present.
    const columns = this.db
        .prepare("PRAGMA table_info(messages)")
        .all() as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has("attribution")) {
        this.db.exec(
            "ALTER TABLE messages ADD COLUMN attribution TEXT",
        );
    }
}
```

### Example 4: Persisting Inbound Attribution in handleIncomingMessage()

```typescript
// In handleIncomingMessage(), after extracting body and inboundAttribution:
const messageRecord: MessageRecord = {
    id: messageId,
    connectionAddress: senderAddress,
    direction: "inbound",
    body,
    sequence: Number(plaintextPayload.sequence),
    state: "delivered",
    priority: "normal",
    attribution: inboundAttribution,  // NEW -- persist the extracted attribution
    createdAt: now,
    updatedAt: now,
};
this.messageStore.saveMessage(messageRecord);
```

### Example 5: Surfacing Attribution in pinch-history Output

```typescript
// In pinch-history.ts run():
const output = messages.map((m) => ({
    id: m.id,
    connectionAddress: m.connectionAddress,
    direction: m.direction,
    body: m.body,
    threadId: m.threadId,
    replyTo: m.replyTo,
    priority: m.priority,
    sequence: m.sequence,
    state: m.state,
    attribution: m.attribution ?? null,  // NEW -- surface attribution
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
}));
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No attribution tracking | `application/x-pinch+json` wrapper with `{ text, attribution }` | Phase 6 (06-03-PLAN) | Attribution data exists on the wire but is not persisted |
| 7 bin entries in package.json | 12 bin entries needed (7 existing + 5 Phase 6 tools) | Phase 7 (this phase) | Phase 6 tools are functional but not invocable via pnpm |

**Not deprecated/outdated -- just incomplete:**
- Attribution is correctly encoded, transmitted, and decoded -- it just is not saved to SQLite
- All 5 CLI tools are fully implemented with tests -- they just lack bin entries

## Open Questions

1. **Should outbound messages default to "agent" attribution when not specified?**
   - What we know: `sendMessage()` currently defaults `attribution` to `"agent"` when building the wire payload (line 104 of `message-manager.ts`). This same default should carry through to persistence.
   - Recommendation: Default to `"agent"` in persistence. This is consistent with the wire format behavior and matches the requirement that messages are attributed for clarity.

2. **Should SKILL.md pinch_history documentation be updated to show the attribution field?**
   - What we know: SKILL.md already documents all 12 tools. The pinch_history example output does not include `attribution`.
   - Recommendation: Yes, update the example output in SKILL.md to include `"attribution": "agent"` or `null`.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection of `skill/package.json` (7 existing bin entries, 5 missing)
- Direct codebase inspection of `skill/src/message-store.ts` (no `attribution` column in schema)
- Direct codebase inspection of `skill/src/message-manager.ts` (lines 217-227: attribution extracted but not persisted; line 104: outbound attribution default)
- Direct codebase inspection of `skill/src/autonomy/activity-feed.ts` (lines 94-131: PRAGMA table_info + ALTER TABLE pattern)
- Direct codebase inspection of all 5 Phase 6 CLI tools (fully implemented, self-executable, with tests)

### Secondary (MEDIUM confidence)
- None needed -- all findings are from direct codebase analysis

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new libraries; all patterns already in codebase
- Architecture: HIGH - Changes are minimal, well-scoped additions to existing files
- Pitfalls: HIGH - All pitfalls identified from direct code analysis; mitigations are proven patterns

**Research date:** 2026-02-27
**Valid until:** Indefinite -- this is internal codebase analysis, not library-dependent
