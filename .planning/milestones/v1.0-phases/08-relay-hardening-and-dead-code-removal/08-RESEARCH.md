# Phase 8: Relay Hardening and Dead Code Removal - Research

**Researched:** 2026-02-27
**Domain:** Go relay dead code removal and WebSocket origin security
**Confidence:** HIGH

## Summary

Phase 8 is a surgical cleanup phase with two well-defined tasks: (1) remove the dead `TrackFlushKey`/`PopFlushKey` code path from the relay hub, and (2) gate the `InsecureSkipVerify: true` WebSocket accept option behind an explicit development flag so production defaults to secure origin verification.

Both changes are low-risk. The flush key code was designed for a delivery-confirmation-based deletion strategy but was superseded by immediate deletion during flush (Phase 4 decision [04-02]). It is never called in production -- `TrackFlushKey` has zero callers. The `InsecureSkipVerify` flag disables `coder/websocket`'s origin verification, which is appropriate for local development but must not ship as a hardcoded default.

**Primary recommendation:** Remove the dead flush key code (methods, fields, struct members, imports, and the RouteMessage delivery-confirm correlation block), then gate `InsecureSkipVerify` behind `PINCH_RELAY_DEV=1` following the project's existing `PINCH_RELAY_*` env var convention.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RELY-06 | Relay flushes queued messages to agent on reconnection in order | Flush behavior is correct (immediate deletion); this phase removes dead code from an alternative approach that was never activated. Flush correctness is unaffected. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `github.com/coder/websocket` | v1.8.14 | WebSocket server with origin verification | Already in use; `AcceptOptions.InsecureSkipVerify` and `OriginPatterns` are the relevant fields |
| Go stdlib `os` | 1.24 | Environment variable reading | Already in use for all `PINCH_RELAY_*` config |

### Supporting
No new dependencies needed. This phase only removes code and adds a conditional check.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `PINCH_RELAY_DEV` env var | Build tags (`//go:build dev`) | Build tags require separate binaries for dev/prod; env var is simpler, consistent with existing config pattern, and switchable at runtime |
| `OriginPatterns` allow-list | `InsecureSkipVerify` gated by flag | `OriginPatterns` is more granular but requires knowing deployment origins upfront; for Pinch's agent-to-agent use case, disabling origin check entirely in dev is appropriate since agents connect programmatically, not from browsers |

## Architecture Patterns

### Relevant File Structure
```
relay/
├── cmd/pinchd/main.go          # InsecureSkipVerify change (production entry point)
├── internal/hub/
│   ├── client.go               # TrackFlushKey/PopFlushKey removal + field/import cleanup
│   ├── hub.go                  # Delivery-confirm correlation block removal + import cleanup
│   └── hub_test.go             # InsecureSkipVerify stays (test code, always needs it)
```

### Pattern 1: Dead Code Removal (TrackFlushKey/PopFlushKey)
**What:** Remove methods, struct fields, and the calling code that was never wired up
**When to use:** When an alternative implementation (immediate deletion) superseded the planned approach

**Removal checklist:**
1. `client.go`: Remove `flushKeys map[string][]byte` field and `flushMu sync.Mutex` field from `Client` struct
2. `client.go`: Remove `TrackFlushKey()` method (lines 191-200)
3. `client.go`: Remove `PopFlushKey()` method (lines 202-214)
4. `client.go`: Remove `"sync"` from imports (only used by `flushMu`)
5. `hub.go`: Remove the delivery-confirm flush correlation block (lines 267-284) -- the entire `if env.Type == MESSAGE_TYPE_DELIVERY_CONFIRM { ... }` block
6. `hub.go`: Remove `"encoding/hex"` from imports (only used by `hex.EncodeToString` in the removed block)

**What to keep:**
- `flushing atomic.Bool` field -- actively used by `IsFlushing()`, `SetFlushing()`
- `flushQueuedMessages()` in hub.go -- actively used for flush-on-reconnect
- `sync/atomic` import in client.go -- used by `flushing atomic.Bool`

### Pattern 2: Environment-Gated Development Flag
**What:** Gate `InsecureSkipVerify` behind `PINCH_RELAY_DEV` env var
**When to use:** When a development convenience must not be active in production

**Example:**
```go
// In main.go, alongside other env var reads:
devMode := os.Getenv("PINCH_RELAY_DEV") == "1"

// In wsHandler, pass devMode as parameter:
func wsHandler(serverCtx context.Context, h *hub.Hub, relayHost string, devMode bool) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
            InsecureSkipVerify: devMode,
        })
        // ...
    }
}
```

### Anti-Patterns to Avoid
- **Removing InsecureSkipVerify from test code:** The 6 uses in `hub_test.go` are correct -- test servers need to accept cross-origin WebSocket connections from `httptest.Server`. Do NOT touch test files.
- **Using OriginPatterns for production:** Pinch agents connect via TypeScript skill code (not browsers), so origin verification is about preventing CSRF from browser contexts. The default (no `InsecureSkipVerify`, no `OriginPatterns`) requires the request host to match the origin, which is correct for same-origin production.
- **Adding a separate config struct:** The existing pattern is flat env var reads at the top of `main()`. Follow this pattern.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Origin verification | Custom origin check middleware | `coder/websocket` built-in `AcceptOptions` | Library already implements RFC 6455 origin verification correctly |
| Dev/prod config switching | Build tags or config files | `PINCH_RELAY_DEV` env var | Consistent with existing `PINCH_RELAY_*` pattern, zero config file overhead |

**Key insight:** This phase removes code, not adds it. The main risk is removing too much or too little.

## Common Pitfalls

### Pitfall 1: Removing the wrong flush code
**What goes wrong:** Accidentally removing `flushing atomic.Bool`, `IsFlushing()`, `SetFlushing()`, or `flushQueuedMessages()` which are actively used
**Why it happens:** They share the "flush" naming prefix with the dead code
**How to avoid:** The dead code is specifically: `flushKeys`, `flushMu`, `TrackFlushKey()`, `PopFlushKey()`, and the delivery-confirm correlation block in `RouteMessage`. Everything else with "flush" in the name is live.
**Warning signs:** Tests fail after removal; `flushQueuedMessages` or `SetFlushing` become undefined

### Pitfall 2: Breaking the import list
**What goes wrong:** Leaving `"sync"` or `"encoding/hex"` imports after removing their only consumers, or accidentally removing imports that are still needed
**Why it happens:** Go refuses to compile with unused imports
**How to avoid:** After each removal, check if the import is used elsewhere in the file. `"sync"` in client.go: only used by `flushMu`. `"encoding/hex"` in hub.go: only used in the delivery-confirm block.
**Warning signs:** `go build` fails with "imported and not used"

### Pitfall 3: Forgetting to pass devMode through the call chain
**What goes wrong:** `InsecureSkipVerify` is gated in `main()` but the boolean never reaches `wsHandler`
**Why it happens:** `wsHandler` is a function that returns an `http.HandlerFunc` -- the devMode needs to be captured in the closure
**How to avoid:** Add `devMode bool` parameter to `wsHandler`, thread it from `main()` where the env var is read
**Warning signs:** `InsecureSkipVerify` is always false regardless of env var

### Pitfall 4: Changing test file behavior
**What goes wrong:** Tests break because `InsecureSkipVerify` was changed in test helpers
**Why it happens:** Overzealous grep-and-replace
**How to avoid:** Only modify `relay/cmd/pinchd/main.go` for the InsecureSkipVerify change. The 6 occurrences in `hub_test.go` must remain `true`.
**Warning signs:** Test failures with "request origin not allowed" errors

## Code Examples

### Dead code removal in client.go

**Before (current):**
```go
type Client struct {
    hub       *Hub
    conn      *websocket.Conn
    address   string
    PublicKey ed25519.PublicKey
    send      chan []byte
    ctx       context.Context
    cancel    context.CancelFunc
    flushing  atomic.Bool

    // DEAD CODE: flushKeys and flushMu
    flushKeys map[string][]byte
    flushMu   sync.Mutex
}
```

**After (target):**
```go
type Client struct {
    hub       *Hub
    conn      *websocket.Conn
    address   string
    PublicKey ed25519.PublicKey
    send      chan []byte
    ctx       context.Context
    cancel    context.CancelFunc
    flushing  atomic.Bool
}
```

### Dead code removal in hub.go RouteMessage

**Before (current, lines 267-284):**
```go
// Handle delivery confirmations for flush correlation...
if env.Type == pinchv1.MessageType_MESSAGE_TYPE_DELIVERY_CONFIRM {
    dc := env.GetDeliveryConfirm()
    if dc != nil && h.mq != nil {
        msgIdHex := hex.EncodeToString(dc.MessageId)
        if bboltKey, ok := from.PopFlushKey(msgIdHex); ok {
            if err := h.mq.Remove(from.Address(), bboltKey); err != nil {
                // ...
            }
        }
    }
}
```

**After:** Remove this entire block. Delivery confirmations are still routed normally through the `switch` statement and `recipient.Send()` -- they just no longer attempt the dead flush key correlation.

### InsecureSkipVerify gating in main.go

**Current:**
```go
conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
    // Allow connections from any origin in development.
    InsecureSkipVerify: true,
})
```

**Target:**
```go
// In main(), alongside other env var reads:
devMode := os.Getenv("PINCH_RELAY_DEV") == "1"
if devMode {
    slog.Warn("development mode enabled: WebSocket origin verification disabled")
}

// wsHandler signature change:
r.Get("/ws", wsHandler(ctx, h, relayHost, devMode))

// In wsHandler:
func wsHandler(serverCtx context.Context, h *hub.Hub, relayHost string, devMode bool) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
            InsecureSkipVerify: devMode,
        })
        // ...
    }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Delivery-confirm-based queue deletion (TrackFlushKey) | Immediate deletion after Send (Phase 4, [04-02]) | Phase 4 implementation | TrackFlushKey code became dead; immediate deletion is simpler and avoids race conditions |
| Hardcoded InsecureSkipVerify: true | Should be env-var gated | This phase | Production relay will enforce WebSocket origin verification by default |

**Deprecated/outdated:**
- `TrackFlushKey`/`PopFlushKey`: Dead since Phase 4. Originally designed for delivery-confirmation-based deletion but superseded by immediate deletion strategy ([04-02] decision: "Immediate deletion on flush (Remove after Send) instead of deferred deletion via delivery confirmation").

## Open Questions

None. Both changes are fully scoped with clear before/after states. The codebase is small and all references have been identified.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection of `relay/internal/hub/client.go`, `relay/internal/hub/hub.go`, `relay/cmd/pinchd/main.go`, `relay/internal/hub/hub_test.go`
- `go doc github.com/coder/websocket AcceptOptions` -- verified InsecureSkipVerify disables origin verification, OriginPatterns is the granular alternative
- `go test ./...` -- all relay tests pass (baseline confirmed)
- `.planning/v1.0-MILESTONE-AUDIT.md` -- audit identified both items as tech debt
- `.planning/STATE.md` -- decision [04-02]: "Immediate deletion on flush (Remove after Send) instead of deferred deletion via delivery confirmation"

### Secondary (MEDIUM confidence)
- None needed -- all findings verified against source code

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies; removing code and adding one env var check
- Architecture: HIGH - exact lines to change identified via grep; all 6 test file occurrences confirmed as correct (must not change)
- Pitfalls: HIGH - verified import dependencies (`sync` only used by `flushMu`, `encoding/hex` only used in delivery-confirm block)

**Research date:** 2026-02-27
**Valid until:** No expiration -- findings are about existing code, not evolving libraries
