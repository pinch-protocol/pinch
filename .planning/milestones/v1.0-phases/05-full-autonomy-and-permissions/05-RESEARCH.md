# Phase 5: Full Autonomy and Permissions - Research

**Researched:** 2026-02-26
**Domain:** Agent-side autonomy state machine, permissions manifests, circuit breakers
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Full Manual**: Queue every inbound message for human approval. Queue indefinitely -- no TTL, no auto-reject. Messages sit until the human acts.
- **Notify**: Agent processes messages autonomously. Actions appear in the activity feed with a "processed autonomously" badge. No push notifications -- human sees it when they check the feed.
- **Auto-respond**: Agent handles messages according to a natural language policy written by the human (e.g., "respond to scheduling requests, reject file transfers"). The LLM interprets the policy per-message. Flexible but the human accepts the interpretive nature.
- **Full Auto**: Agent operates independently. The permissions manifest IS the guardrail -- no extra limits beyond what the manifest allows plus circuit breakers. Everything logged to audit trail.
- **Permissions manifest design**: Deny-by-default. Nothing gets through unless explicitly allowed. New message types are blocked until the human permits them.
- **Domain-specific capability tiers** (fixed core set):
  - Calendar: none / free-busy only / full details / propose & book
  - Files: none / specific folders / everything
  - Actions: whether the other agent can request your agent to do things on your behalf (yes/no or scoped)
  - Spending: dollar cap per transaction, per day, per connection
  - Information boundaries: explicit exclusions defined in natural language (e.g., "never share my financials, health info, or other business relationships")
- **Fixed core + optional custom categories**: Core categories are enforced structurally. Humans can add custom categories that are LLM-interpreted (similar to information boundaries).
- **Uncertain boundary handling**: When the LLM is uncertain whether content violates an information boundary, block the message and escalate to the human for a decision.
- **Circuit breaker triggers** (all four active): message flood, permission violations, spending cap exceeded, boundary probing
- **Downgrade behavior**: Straight to Full Manual on any circuit breaker trigger. No gradual step-down.
- **Recovery**: Human must manually re-upgrade. No automatic recovery, no cooldown-based restoration.
- **Notification**: Circuit breaker event appears in the activity feed with trigger details, plus the connection gets a warning badge so it stands out.
- **Autonomy change timing**: Changes take effect immediately -- applies to the very next inbound message. Messages already being processed complete under the old level.
- **Peer notification**: The peer agent is NOT notified of autonomy level changes.
- **Agent suggestions**: The agent can suggest autonomy changes (surfaced in activity feed) but the human must approve. No self-upgrade.
- **No restrictions**: Human can set any autonomy level at any time, including Full Auto on a brand-new connection.

### Claude's Discretion
- Exact threshold values for circuit breaker triggers (message flood rate, violation count before trip)
- How the natural language policy is stored and passed to the LLM for Auto-respond evaluation
- Internal representation of the permissions manifest (JSON schema, protobuf, etc.)
- How "processed autonomously" badge surfaces in the activity feed data model

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AUTO-03 | Full Manual: agent queues inbound messages for human approval before processing | Extend InboundRouter with Full Manual handler (already partially implemented -- routes to `escalated_to_human`). Add indefinite queue semantics (no TTL). |
| AUTO-04 | Notify: agent processes messages autonomously and notifies human of actions taken | New InboundRouter branch for `notify` level. Mark messages as `read_by_agent` AND create activity feed entry with "processed autonomously" badge. |
| AUTO-05 | Auto-respond: agent handles messages within configured rules, logs everything | New InboundRouter branch for `auto_respond` level. Store natural language policy per connection. Pass policy + message to LLM for per-message evaluation. Log every decision. |
| AUTO-06 | Full Auto: agent operates independently, logs to audit trail | Extend existing `full_auto` branch in InboundRouter. Add audit trail logging for every action. Permissions manifest is the only guardrail. |
| AUTO-07 | Human can change autonomy level for any connection at any time | Extend `AutonomyLevel` type to include `notify` and `auto_respond`. Add `pinch-autonomy` tool. Immediate effect via ConnectionStore.setAutonomy(). |
| AUTO-08 | Inbound permissions manifest defines what message types/actions a connection can send | New `PermissionsManifest` type with domain-specific capability tiers. Stored per-connection in ConnectionStore. JSON representation. |
| AUTO-09 | Permissions are enforced at the agent level before decrypted content reaches the LLM | New `PermissionsEnforcer` that runs between decryption and InboundRouter. Checks manifest before any content processing. |
| AUTO-10 | Circuit breakers auto-downgrade autonomy level when a connection exhibits anomalous behavior | New `CircuitBreaker` class with sliding window counters for four trigger types. Downgrades to Full Manual. Warning badge on connection. |
</phase_requirements>

## Summary

Phase 5 transforms the existing two-state autonomy system (Full Manual / Full Auto) into a four-tier graduated autonomy state machine with an inbound permissions manifest and circuit breakers. The current codebase already has the foundation: `InboundRouter` dispatches messages based on `connection.autonomyLevel`, `ConnectionStore` persists the autonomy level, and `setAutonomy()` changes it with a confirmation gate.

The work is entirely TypeScript-side. The relay remains cryptographically blind and requires zero changes. The existing `AutonomyLevel` type must be extended from `"full_manual" | "full_auto"` to `"full_manual" | "notify" | "auto_respond" | "full_auto"`. The `InboundRouter.route()` method needs two new branches (Notify and Auto-respond). A `PermissionsManifest` type and enforcer must be added as a pre-routing gate. A `CircuitBreaker` class must monitor connection behavior and auto-downgrade to Full Manual when anomalies are detected.

The most technically novel aspect is the Auto-respond tier, which requires LLM evaluation of a human-written natural language policy per message. This is not a traditional deterministic check -- it requires passing the policy text and message content to the LLM and interpreting the response. Information boundaries in the permissions manifest also require LLM evaluation, with uncertain outcomes blocking the message and escalating to the human.

**Primary recommendation:** Implement in three stages: (1) extend autonomy types and InboundRouter with all four tiers + autonomy change tool, (2) permissions manifest with structural enforcement and LLM-evaluated boundaries, (3) circuit breakers with sliding window counters.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | Message store, audit trail, activity feed persistence | Already in project. WAL mode for concurrent reads. |
| vitest | latest | Unit and integration testing | Already in project. Fast, ESM-native. |
| uuid | ^13.0.0 | UUIDv7 for message and event IDs | Already in project. Time-ordered, collision-free. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All Phase 5 work uses existing dependencies |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled state machine | xstate v5 | xstate is powerful but overkill for a 4-state linear machine with no hierarchical states. The autonomy FSM has only 4 states and ~8 transitions -- a simple switch/map is clearer and avoids a 50KB+ dependency. |
| JSON for permissions manifest | Protobuf | Permissions are local-only (never sent over the wire). JSON is human-readable, editable, and the ConnectionStore already uses JSON. Protobuf adds unnecessary complexity for client-side-only data. |
| External circuit breaker library | Hand-rolled | Existing libraries (opossum, cockatiel) are designed for service-to-service resilience, not per-connection message rate monitoring. The four trigger types are domain-specific. A simple sliding window counter with configurable thresholds is ~50 lines and perfectly testable. |

**Installation:**
```bash
# No new packages needed -- all Phase 5 work uses existing dependencies
```

## Architecture Patterns

### Recommended Project Structure
```
skill/src/
├── autonomy/                    # NEW: Autonomy enforcement module
│   ├── autonomy-router.ts       # Extended InboundRouter (replaces/wraps current)
│   ├── permissions-manifest.ts  # PermissionsManifest type + PermissionsEnforcer
│   ├── circuit-breaker.ts       # CircuitBreaker with sliding window counters
│   ├── policy-evaluator.ts      # LLM policy evaluation for Auto-respond + boundaries
│   └── activity-feed.ts         # Activity feed data model (events, badges)
├── connection-store.ts          # MODIFIED: Extended AutonomyLevel, manifest storage
├── inbound-router.ts            # MODIFIED: Delegates to autonomy-router
├── message-store.ts             # MODIFIED: New activity_events table
└── tools/
    ├── pinch-autonomy.ts        # NEW: Set autonomy level tool
    └── pinch-permissions.ts     # NEW: Configure permissions manifest tool
```

### Pattern 1: Layered Enforcement Pipeline
**What:** Messages pass through a pipeline of checks before reaching the LLM: permissions manifest (structural) -> circuit breaker check -> autonomy-level routing -> LLM evaluation (only for auto_respond and information boundaries).
**When to use:** Every inbound message after decryption.
**Example:**
```typescript
// Enforcement pipeline (executed in InboundRouter.route or a wrapper)
class EnforcementPipeline {
  constructor(
    private permissionsEnforcer: PermissionsEnforcer,
    private circuitBreaker: CircuitBreaker,
    private autonomyRouter: AutonomyRouter,
  ) {}

  async enforce(message: MessageRecord, connectionAddress: string): Promise<RoutedMessage> {
    // 1. Permissions check (structural, no LLM needed for core categories)
    const permResult = this.permissionsEnforcer.check(message, connectionAddress);
    if (permResult.denied) {
      this.circuitBreaker.recordViolation(connectionAddress, 'permission_violation');
      return { ...message, state: 'failed', failureReason: permResult.reason };
    }

    // 2. Circuit breaker check (may auto-downgrade)
    this.circuitBreaker.recordMessage(connectionAddress);
    if (this.circuitBreaker.isTripped(connectionAddress)) {
      // Already downgraded -- route under new autonomy level
    }

    // 3. Autonomy-level routing
    return this.autonomyRouter.route(message, connectionAddress);
  }
}
```

### Pattern 2: Sliding Window Counter for Circuit Breakers
**What:** A time-windowed counter that tracks events per connection within a configurable window (e.g., 60 seconds). When the count exceeds a threshold, the circuit breaker trips.
**When to use:** Message flood detection, permission violation counting, boundary probing detection.
**Example:**
```typescript
interface WindowEntry {
  timestamp: number;
  type: 'message' | 'permission_violation' | 'spending_exceeded' | 'boundary_probe';
}

class SlidingWindowCounter {
  private events: Map<string, WindowEntry[]> = new Map();

  record(connectionAddress: string, type: WindowEntry['type']): void {
    const entries = this.events.get(connectionAddress) ?? [];
    entries.push({ timestamp: Date.now(), type });
    this.events.set(connectionAddress, entries);
  }

  count(connectionAddress: string, type: WindowEntry['type'], windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const entries = this.events.get(connectionAddress) ?? [];
    // Prune old entries
    const active = entries.filter(e => e.timestamp > cutoff);
    this.events.set(connectionAddress, active);
    return active.filter(e => e.type === type).length;
  }
}
```

### Pattern 3: Permissions Manifest as JSON with TypeScript Types
**What:** The permissions manifest is a typed JSON object stored alongside the connection in the ConnectionStore. Core categories have structural types; custom categories and information boundaries are free-text strings evaluated by the LLM.
**When to use:** Per-connection permissions configuration and enforcement.
**Example:**
```typescript
/** Calendar permission tiers (structural -- no LLM needed). */
type CalendarPermission = 'none' | 'free_busy_only' | 'full_details' | 'propose_and_book';

/** File permission tiers (structural). */
type FilePermission = 'none' | 'specific_folders' | 'everything';

/** Action permission (structural). */
type ActionPermission = 'none' | 'scoped' | 'full';

/** Spending caps (structural). */
interface SpendingCaps {
  perTransaction: number;  // USD, 0 = disabled
  perDay: number;
  perConnection: number;
}

/** The complete permissions manifest for a connection. */
interface PermissionsManifest {
  calendar: CalendarPermission;
  files: FilePermission;
  allowedFolders?: string[];  // Only when files === 'specific_folders'
  actions: ActionPermission;
  actionScopes?: string[];    // Only when actions === 'scoped'
  spending: SpendingCaps;
  informationBoundaries: string[];   // Natural language exclusions, LLM-evaluated
  customCategories: CustomCategory[];  // User-defined, LLM-interpreted
}

interface CustomCategory {
  name: string;
  description: string;  // Natural language rule
  allowed: boolean;      // Default posture for this category
}
```

### Pattern 4: LLM Policy Evaluation (Auto-respond + Information Boundaries)
**What:** For Auto-respond autonomy level, the human writes a natural language policy. For information boundaries, the human defines exclusion rules. Both require passing the policy/boundary text and the message content to the LLM, which returns a structured decision.
**When to use:** Auto-respond routing decisions, information boundary checks.
**Example:**
```typescript
interface PolicyDecision {
  action: 'allow' | 'deny' | 'escalate';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

// The policy evaluator is an INTERFACE -- the actual LLM call is injected.
// This keeps the skill testable without requiring an LLM in tests.
interface PolicyEvaluator {
  evaluatePolicy(params: {
    policy: string;          // Human-written natural language policy
    messageBody: string;     // The inbound message content
    senderAddress: string;   // Context about who sent it
    connectionNickname: string;
  }): Promise<PolicyDecision>;

  checkInformationBoundary(params: {
    boundaries: string[];    // List of exclusion rules
    content: string;         // Content about to be shared/processed
  }): Promise<PolicyDecision>;
}
```

### Anti-Patterns to Avoid
- **Combining permissions and autonomy into one check:** Permissions are enforced BEFORE autonomy routing. They are separate concerns. A message can pass permissions but still be queued for human review (Full Manual). Mixing them creates confusing edge cases.
- **Storing autonomy state in memory only:** The ConnectionStore persists to disk. Circuit breaker state (downgrade) must also persist. If the agent restarts, a connection that was circuit-broken should remain in Full Manual, not silently revert.
- **Making the LLM call synchronous and blocking:** Auto-respond policy evaluation involves an LLM call which has latency. The evaluation should be async. If the LLM is unavailable, escalate to human (safe default).
- **Notifying the peer of autonomy changes:** Per locked decision, the peer agent is NOT notified. The system must not leak trust configuration to the other side.
- **Allowing circuit breaker auto-recovery:** Per locked decision, human must manually re-upgrade. No automatic recovery, no cooldown-based restoration. The circuit breaker trips and stays tripped until the human intervenes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| UUID generation | Custom ID scheme | uuid v13 (UUIDv7) | Already in project. Time-ordered. |
| SQLite persistence | Custom file-based storage | better-sqlite3 | Already in project. WAL mode, transactions. |
| JSON serialization | Custom serializer | JSON.stringify/parse with TypeScript types | Permissions manifest is local-only, human-readable JSON is ideal. |

**Key insight:** Phase 5 introduces no new external dependencies. The entire implementation uses existing libraries (better-sqlite3, vitest, uuid) and TypeScript's type system for safety. The novel aspects (LLM policy evaluation, information boundary checking) are interfaces that the OpenClaw agent runtime satisfies -- the skill defines the contract, not the implementation.

## Common Pitfalls

### Pitfall 1: Race Condition on Autonomy Level Change
**What goes wrong:** Human changes autonomy level from Full Auto to Full Manual while a message is being processed under Full Auto. The message completes under the old level, but the next message sees the new level.
**Why it happens:** The locked decision says "messages already being processed complete under the old level." But JavaScript is single-threaded for synchronous code, and `route()` is synchronous. The risk is only if async LLM evaluation (Auto-respond) is in progress when the level changes.
**How to avoid:** Read the autonomy level at the START of routing and use that snapshot for the entire message lifecycle. Don't re-read mid-processing. For Auto-respond async evaluation, capture the policy and level before the await.
**Warning signs:** Inconsistent message states for messages processed around autonomy change boundaries.

### Pitfall 2: Information Boundary Bypass via Gradual Disclosure
**What goes wrong:** An adversarial agent sends a series of innocuous messages that individually don't trigger information boundaries but collectively extract sensitive information.
**Why it happens:** Each message is evaluated independently against the boundary rules. There's no cross-message context.
**How to avoid:** This is the "boundary probing" circuit breaker trigger. Track escalation frequency per connection. If the LLM frequently reports "low confidence" or "uncertain" for a connection's messages, that's a signal to trip the circuit breaker.
**Warning signs:** Rising count of `escalate` decisions from the policy evaluator for a single connection.

### Pitfall 3: Permissions Manifest Default State
**What goes wrong:** A new connection has no permissions manifest configured. If the default is "allow all," the deny-by-default principle is violated.
**Why it happens:** Forgetting to set a default manifest when a connection is created.
**How to avoid:** The ConnectionStore.addConnection() method must assign a DEFAULT permissions manifest that denies everything (calendar: 'none', files: 'none', actions: 'none', spending: all zeros, empty boundaries). This is the structural equivalent of deny-by-default.
**Warning signs:** Connections without a permissions manifest in the store.

### Pitfall 4: Circuit Breaker State Loss on Restart
**What goes wrong:** The agent restarts and the circuit breaker state is lost. A connection that was circuit-broken to Full Manual reverts to its previous level.
**Why it happens:** Circuit breaker state stored only in memory.
**How to avoid:** When a circuit breaker trips, it calls `connectionStore.setAutonomy(address, 'full_manual')` which persists to disk. The circuit breaker counters can be in-memory (they reset on restart, which is fine -- the autonomy downgrade is already persisted). Additionally, store a `circuitBreakerTripped` flag on the connection so the UI can show the warning badge.
**Warning signs:** Connections that were previously circuit-broken appearing at a higher autonomy level after restart.

### Pitfall 5: LLM Unavailability During Auto-respond
**What goes wrong:** The LLM is down or slow. Auto-respond messages can't be evaluated. Messages pile up or timeout.
**Why it happens:** LLM is an external dependency with variable latency and availability.
**How to avoid:** If the LLM evaluation fails or times out (e.g., 10-second timeout), treat it as an escalation to human. This is the safe default -- equivalent to temporarily behaving like Full Manual for that specific message. Log the LLM failure for debugging.
**Warning signs:** Increasing `escalated_to_human` messages on connections configured as Auto-respond.

## Code Examples

Verified patterns from existing codebase:

### Extending AutonomyLevel Type
```typescript
// Current (connection-store.ts):
export type AutonomyLevel = "full_manual" | "full_auto";

// Phase 5 extension:
export type AutonomyLevel = "full_manual" | "notify" | "auto_respond" | "full_auto";
```

### Extending InboundRouter.route()
```typescript
// Current route() has: full_auto -> read_by_agent, else -> escalated_to_human
// Phase 5 adds two new branches:

route(message: MessageRecord, connectionAddress: string): RoutedMessage {
  const connection = this.connectionStore.getConnection(connectionAddress);
  if (!connection || connection.state !== "active") {
    // ... existing unknown sender handling
  }

  switch (connection.autonomyLevel) {
    case "full_auto":
      this.messageStore.updateState(message.id, "read_by_agent");
      return { ...result, state: "read_by_agent" };

    case "notify":
      // Process autonomously (like full_auto) BUT create activity feed entry
      this.messageStore.updateState(message.id, "read_by_agent");
      this.activityFeed.record({
        type: 'message_processed_autonomously',
        connectionAddress,
        messageId: message.id,
        badge: 'processed_autonomously',
      });
      return { ...result, state: "read_by_agent" };

    case "auto_respond":
      // Mark as pending policy evaluation
      this.messageStore.updateState(message.id, "pending_policy_eval");
      // Async LLM evaluation happens separately (see PolicyEvaluator)
      return { ...result, state: "pending_policy_eval" };

    case "full_manual":
    default:
      this.messageStore.updateState(message.id, "escalated_to_human");
      return { ...result, state: "escalated_to_human" };
  }
}
```

### ConnectionStore.setAutonomy() Extension
```typescript
// Current setAutonomy() only gates full_manual -> full_auto upgrade.
// Phase 5 needs: all 4 levels, no upgrade confirmation for intermediate levels,
// but per locked decision: "Human can set any autonomy level at any time."
// The confirmation gate should only apply for transitions TO full_auto.

setAutonomy(
  peerAddress: string,
  level: AutonomyLevel,
  opts?: { confirmed?: boolean },
): Connection {
  const conn = this.data.connections[peerAddress];
  if (!conn) throw new Error(`connection not found: ${peerAddress}`);

  // Gate: upgrading TO full_auto from any level requires confirmation.
  if (level === "full_auto" && conn.autonomyLevel !== "full_auto" && opts?.confirmed !== true) {
    throw new Error("Upgrading to Full Auto requires explicit confirmation");
  }

  return this.updateConnection(peerAddress, { autonomyLevel: level });
}
```

### Default Permissions Manifest
```typescript
function defaultPermissionsManifest(): PermissionsManifest {
  return {
    calendar: 'none',
    files: 'none',
    actions: 'none',
    spending: { perTransaction: 0, perDay: 0, perConnection: 0 },
    informationBoundaries: [],
    customCategories: [],
  };
}
```

### Activity Feed Event Schema (SQLite)
```sql
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  connection_address TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message_id TEXT,
  badge TEXT,
  details TEXT,  -- JSON blob for event-specific data
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_connection
  ON activity_events(connection_address, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_type
  ON activity_events(event_type, created_at);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Binary allow/deny permissions | Graduated capability tiers (none -> partial -> full) | 2024-2025, capability-based security models | More granular control without complexity explosion |
| Rule-based content filtering | LLM-evaluated natural language policies | 2024-2025, LLM guardrails evolution | Flexible human-like interpretation, but requires uncertainty handling |
| Manual circuit breakers | Automated sliding window detection | Standard pattern | Faster response to anomalies, but needs human recovery per locked decision |
| Permission-per-action models | Domain-specific permission manifests | Emerging in agent frameworks | Maps to real-world trust patterns ("I trust you with calendar but not files") |

**Deprecated/outdated:**
- Binary permissions (allow/deny per message type): Too coarse for agent-to-agent messaging where trust is granular
- Rule-based content filtering with regex/keyword matching: Fails on context-dependent scenarios; LLM evaluation is the current approach for natural language policies

## Open Questions

1. **LLM Interface for Policy Evaluation**
   - What we know: The skill needs to evaluate natural language policies against message content. This requires an LLM call.
   - What's unclear: How exactly the OpenClaw agent runtime exposes LLM access to the skill. The skill currently uses CLI tools (pinch-send, pinch-connect) that don't call an LLM.
   - Recommendation: Define a `PolicyEvaluator` interface in the skill. The actual implementation depends on how OpenClaw skills invoke LLM capabilities. For now, the interface is the contract -- implementation can be injected. Tests use a mock evaluator.

2. **Activity Feed Persistence Location**
   - What we know: Activity events need to be stored for human review. The existing MessageStore uses SQLite (better-sqlite3).
   - What's unclear: Should activity events go in the same SQLite database as messages, or a separate one?
   - Recommendation: Same database. The MessageStore already handles WAL mode and the activity_events table is lightweight. A separate DB adds unnecessary complexity.

3. **Permissions Manifest Storage**
   - What we know: The ConnectionStore is a JSON file. The permissions manifest is per-connection.
   - What's unclear: Should the manifest live inside the connection JSON or in a separate store?
   - Recommendation: Inside the connection JSON. The `Connection` interface gets a new `permissionsManifest` field. This keeps all per-connection state in one place and avoids a second file/store to keep in sync.

4. **Auto-respond Policy Storage**
   - What we know: The human writes a natural language policy for Auto-respond. This is per-connection.
   - What's unclear: Where to store this policy text.
   - Recommendation: New `autoRespondPolicy` field on the `Connection` interface. It's a string (potentially multi-line). Stored in the same connections.json alongside the manifest and autonomy level.

## Sources

### Primary (HIGH confidence)
- Existing codebase: `skill/src/inbound-router.ts`, `skill/src/connection-store.ts`, `skill/src/connection.ts`, `skill/src/message-manager.ts` -- current autonomy implementation analyzed directly
- Existing codebase: `proto/pinch/v1/envelope.proto` -- wire protocol analyzed for scope of changes (none needed for Phase 5)
- Existing codebase: `skill/src/tools/cli.ts` -- bootstrap pattern for new tools

### Secondary (MEDIUM confidence)
- Circuit breaker pattern: Standard software engineering pattern well-documented across multiple sources. Sliding window counter is the established approach for time-based anomaly detection.
- JSON Schema for typed manifests: Standard approach for typed configuration with validation. `additionalProperties: false` enforces deny-by-default at the schema level.

### Tertiary (LOW confidence)
- LLM policy evaluation patterns: The field of LLM guardrails is evolving rapidly. The interface-based approach (define contract, inject implementation) is the safe choice because the exact LLM invocation mechanism depends on OpenClaw runtime capabilities that may change.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing libraries
- Architecture: HIGH -- extends existing patterns (InboundRouter, ConnectionStore), well-understood state machine
- Pitfalls: HIGH -- race conditions and default states are well-known; LLM unavailability is the main risk
- LLM integration: MEDIUM -- interface design is solid, but actual OpenClaw LLM invocation mechanism is unclear

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (stable -- no fast-moving external dependencies)
