# Phase 9: Skill Documentation and CLI Optimization - Research

**Researched:** 2026-02-27
**Domain:** CLI architecture refactoring / documentation accuracy
**Confidence:** HIGH

## Summary

Phase 9 addresses two cleanup items identified during the Phase 5/6 audit: (1) incorrect permission tier names in SKILL.md, and (2) unnecessary relay WebSocket connections in local-only CLI tools.

**Success criterion #1 is already satisfied.** Commit `ac386ab` ("fix(05-03): correct permission tier names in SKILL.md to match code") already corrected the tier names from `read`/`read_write`/`execute` to `full_details`/`propose_and_book`/`specific_folders`/`everything`/`scoped`/`full`. The current SKILL.md at lines 379-381 and 396-398 uses the correct names. No further work needed for this criterion.

**Success criterion #2 requires a refactor of `skill/src/tools/cli.ts`.** Currently, `bootstrap()` always calls `relayClient.connect()` (line 119 of cli.ts), which opens a WebSocket connection, performs Ed25519 challenge-response auth, and starts heartbeat pings. The three tools -- `pinch-permissions`, `pinch-audit-verify`, `pinch-audit-export` -- only need local data stores (ConnectionStore JSON file and/or MessageStore SQLite). They never send or receive relay messages.

**Primary recommendation:** Add a `bootstrapLocal()` function to `cli.ts` that initializes only the local data stores (keypair, ConnectionStore, MessageStore, ActivityFeed) without creating a RelayClient or connecting to the relay. Update the three CLI tools to call `bootstrapLocal()` instead of `bootstrap()`.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | SQLite message/activity store | Already used; synchronous API ideal for CLI tools |
| vitest | latest | Test runner | Already the project test framework |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| ws | ^8.19.0 | WebSocket relay connection | Only for tools that need relay (send, connect, intervene) |
| libsodium-wrappers-sumo | 0.8.0 | Ed25519 identity loading | Needed by keypair loading even for local-only tools |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New `bootstrapLocal()` function | Optional `{ relay: false }` param on existing `bootstrap()` | Cleaner separation vs. smaller diff; either approach works, but a separate function makes the intent explicit and prevents accidental relay connection |

**Installation:** No new dependencies required. All libraries already in `skill/package.json`.

## Architecture Patterns

### Current Architecture (Problem)

```
cli.ts bootstrap()
├── loadKeypair()
├── new RelayClient()          ← ALWAYS created
├── new ConnectionStore()
├── connectionStore.load()
├── connectionStore.clearPassthroughFlags()
├── new MessageStore()         ← opens SQLite
├── new ActivityFeed()
├── new PermissionsEnforcer()
├── new CircuitBreaker()
├── new InboundRouter()
├── new EnforcementPipeline()
├── new ConnectionManager()    ← needs relayClient
├── new MessageManager()       ← needs relayClient
├── relayClient.connect()      ← OPENS WEBSOCKET (the problem)
├── connectionManager.setupHandlers()
├── messageManager.setupHandlers()
└── messageManager.init()
```

Every CLI tool calls `bootstrap()`, which unconditionally opens a relay WebSocket connection. For local-only tools (`pinch-permissions`, `pinch-audit-verify`, `pinch-audit-export`), this is wasteful and creates a hard dependency on `PINCH_RELAY_URL` being set and the relay being reachable.

### Pattern 1: Separate `bootstrapLocal()` Function
**What:** A new exported function in `cli.ts` that initializes only local stores and returns a subset of components. Does NOT create a RelayClient, ConnectionManager, MessageManager, or any relay-dependent component.
**When to use:** For CLI tools that only read/write local SQLite or JSON stores.
**Example:**

```typescript
// Source: derived from existing cli.ts pattern

export interface LocalBootstrapResult {
  keypair: Keypair;
  connectionStore: ConnectionStore;
  messageStore: MessageStore;
  activityFeed: ActivityFeed;
}

let localBootstrapped: LocalBootstrapResult | null = null;

export async function bootstrapLocal(): Promise<LocalBootstrapResult> {
  if (localBootstrapped) return localBootstrapped;

  const keypairPath =
    process.env.PINCH_KEYPAIR_PATH ??
    join(homedir(), ".pinch", "keypair.json");
  const dataDir =
    process.env.PINCH_DATA_DIR ?? join(homedir(), ".pinch", "data");

  // Load or generate keypair (no relay needed).
  let keypair: Keypair;
  try {
    keypair = await loadKeypair(keypairPath);
  } catch {
    keypair = await generateKeypair();
    await saveKeypair(keypair, keypairPath);
  }

  const connectionStore = new ConnectionStore(
    join(dataDir, "connections.json"),
  );
  await connectionStore.load();
  await connectionStore.clearPassthroughFlags();

  const messageStore = new MessageStore(join(dataDir, "messages.db"));
  const activityFeed = new ActivityFeed(messageStore.getDb());

  localBootstrapped = { keypair, connectionStore, messageStore, activityFeed };
  return localBootstrapped;
}

export async function shutdownLocal(): Promise<void> {
  if (!localBootstrapped) return;
  localBootstrapped.messageStore.close();
  localBootstrapped = null;
}
```

### Pattern 2: Tool Updates
**What:** Each local-only tool switches from `bootstrap()` to `bootstrapLocal()` and from `shutdown()` to `shutdownLocal()`.
**Example for pinch-permissions:**

```typescript
// Before:
const { connectionStore } = await bootstrap();
// ...
await shutdown();

// After:
const { connectionStore } = await bootstrapLocal();
// ...
await shutdownLocal();
```

**Example for pinch-audit-verify:**

```typescript
// Before:
const { messageStore } = await bootstrap();
// ...
await shutdown();

// After:
const { messageStore } = await bootstrapLocal();
// ...
await shutdownLocal();
```

**Example for pinch-audit-export:**

```typescript
// Before:
const { messageStore } = await bootstrap();
// ...
await shutdown();

// After:
const { messageStore } = await bootstrapLocal();
// ...
await shutdownLocal();
```

### Anti-Patterns to Avoid
- **Modifying `bootstrap()` with optional parameters:** Adding a `{ skipRelay: true }` flag to `bootstrap()` increases complexity and makes the return type ambiguous (some fields would be null). A separate function with a narrower return type is cleaner.
- **Lazy relay connection:** Deferring `relayClient.connect()` to first use would add complexity to every relay-dependent code path. The separate function approach is simpler.
- **Removing PINCH_RELAY_URL requirement from `bootstrapLocal()`:** The local bootstrap should NOT require `PINCH_RELAY_URL` at all. This is the key behavioral difference -- local-only tools work without a running relay.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Local-only CLI bootstrap | A whole new module | Add `bootstrapLocal()` to existing `cli.ts` | Keep all bootstrap logic in one file; reuse shared env var and path resolution |

**Key insight:** The change is small -- a new function in `cli.ts` and three one-line changes in the CLI tools. No new modules or dependencies needed.

## Common Pitfalls

### Pitfall 1: Breaking Existing Tests
**What goes wrong:** Tests import from `cli.ts` and expect specific exports. Adding new exports is safe, but changing existing exports would break consumers.
**Why it happens:** Refactoring shared modules without checking all consumers.
**How to avoid:** `bootstrapLocal()` and `shutdownLocal()` are purely additive. The existing `bootstrap()` and `shutdown()` functions remain unchanged. All other tools continue using `bootstrap()`.
**Warning signs:** Import errors in other tool files after the change.

### Pitfall 2: Forgetting shutdownLocal() / Resource Leak
**What goes wrong:** Tool calls `bootstrapLocal()` but uses `shutdown()` (which expects the full bootstrap result) or forgets to call shutdown at all, leaving the SQLite connection open.
**Why it happens:** Copy-paste from existing tools without updating the shutdown call.
**How to avoid:** Each tool must switch both `bootstrap()` -> `bootstrapLocal()` AND `shutdown()` -> `shutdownLocal()`. The test should verify the tool does not require `PINCH_RELAY_URL`.
**Warning signs:** SQLite "database locked" errors, or PINCH_RELAY_URL error when running local-only tools.

### Pitfall 3: Singleton Interaction Between bootstrap() and bootstrapLocal()
**What goes wrong:** If a tool calls `bootstrapLocal()` and later something calls `bootstrap()` (or vice versa), the two singletons could conflict.
**Why it happens:** Both functions use module-level `let bootstrapped` / `let localBootstrapped` state.
**How to avoid:** No tool should call both. Each tool uses exclusively one or the other. The separate variable names (`bootstrapped` vs `localBootstrapped`) prevent cross-contamination.
**Warning signs:** Unexpected state in components after bootstrap.

### Pitfall 4: SKILL.md Line Number Drift
**What goes wrong:** The success criteria reference "lines 259-278" but line numbers have already shifted due to edits in Phases 6 and 7.
**Why it happens:** Line-based references become stale as files are edited.
**How to avoid:** Verify by content, not line numbers. Search for the permission tier names `full_details`, `propose_and_book`, `specific_folders`, `everything`, `scoped`, `full` in SKILL.md. They currently appear at lines 379-381 and 396-398. The incorrect names (`read`, `read_write`, `execute`) do NOT appear anywhere in the file -- this criterion is already met.
**Warning signs:** None -- already verified.

## Code Examples

Verified patterns from the existing codebase:

### What pinch-permissions Needs (connectionStore only)
```typescript
// Source: skill/src/tools/pinch-permissions.ts line 176
const { connectionStore } = await bootstrap();
// connectionStore is a JSON-backed store at join(dataDir, "connections.json")
// No relay communication happens in this tool
```

### What pinch-audit-verify Needs (messageStore SQLite only)
```typescript
// Source: skill/src/tools/pinch-audit-verify.ts lines 50-51
const { messageStore } = await bootstrap();
const db = messageStore.getDb();
// All operations are direct SQL queries on the local SQLite database
```

### What pinch-audit-export Needs (messageStore SQLite only)
```typescript
// Source: skill/src/tools/pinch-audit-export.ts lines 57-58
const { messageStore } = await bootstrap();
const db = messageStore.getDb();
// All operations are direct SQL queries + writeFile for JSON export
```

### Current bootstrap() Opening Relay Connection (the problem)
```typescript
// Source: skill/src/tools/cli.ts lines 118-122
// Connect to relay and set up handlers.
await relayClient.connect();
connectionManager.setupHandlers();
messageManager.setupHandlers();
await messageManager.init();
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| All CLI tools open full relay WebSocket | All CLI tools open full relay WebSocket | Phase 3 (03-04) | Local-only tools are slow to start and fail when relay is unreachable |
| Incorrect permission tier names in SKILL.md | Correct tier names in SKILL.md | Phase 5 (05-03, commit ac386ab) | Already fixed |

**Already completed:**
- SKILL.md permission tier name correction (commit `ac386ab` in Phase 5)

**Remaining:**
- CLI optimization: `bootstrapLocal()` for local-only tools

## Open Questions

1. **Scope of local-only optimization**
   - What we know: The success criteria explicitly names three tools: `pinch-permissions`, `pinch-audit-verify`, `pinch-audit-export`
   - What's unclear: Several other tools also appear to be local-only (`pinch-status`, `pinch-history`, `pinch-contacts`, `pinch-activity`, `pinch-autonomy`, `pinch-mute`). The phase description limits scope to the three named tools.
   - Recommendation: Only change the three named tools per the success criteria. Note the others as potential future optimization but do not change them in this phase. Changing more tools increases risk without being required.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection: `skill/src/tools/cli.ts` -- bootstrap logic with relay connection at line 119
- Direct codebase inspection: `skill/src/tools/pinch-permissions.ts` -- only uses `connectionStore`
- Direct codebase inspection: `skill/src/tools/pinch-audit-verify.ts` -- only uses `messageStore.getDb()`
- Direct codebase inspection: `skill/src/tools/pinch-audit-export.ts` -- only uses `messageStore.getDb()`
- Git history: commit `ac386ab` -- "fix(05-03): correct permission tier names in SKILL.md to match code"
- Direct codebase inspection: `skill/SKILL.md` lines 379-381, 396-398 -- correct tier names confirmed

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new libraries needed; all existing dependencies
- Architecture: HIGH - `bootstrapLocal()` pattern is a straightforward extraction from existing `bootstrap()` code
- Pitfalls: HIGH - Limited scope (one new function, three tool updates); well-understood codebase

**Research date:** 2026-02-27
**Valid until:** 2026-03-27 (stable -- internal refactoring, no external dependency concerns)
