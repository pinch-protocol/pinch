---
phase: 03-encrypted-1-1-messaging
plan: 03
subsystem: messaging
tags: [nacl-box, e2e-encryption, delivery-confirmation, autonomy-routing, reconnection, sqlite, protobuf]

# Dependency graph
requires:
  - phase: 03-encrypted-1-1-messaging
    provides: MessageStore (SQLite), delivery signing/verification, DeliveryConfirm proto, RelayClient with auth, ConnectionStore with getPeerPublicKey
provides:
  - MessageManager class orchestrating encrypt/send/receive/decrypt/confirm flows
  - InboundRouter class for autonomy-based message routing (full_manual -> escalated_to_human, full_auto -> read_by_agent)
  - RelayClient multi-handler support (onEnvelope pushes to array, all handlers receive same envelope)
  - RelayClient auto-reconnection with exponential backoff and jitter
  - getPendingForReview for HEARTBEAT.md integration
  - approveMessage for human review workflow
affects: [03-04-integration, 04-offline-store-and-forward, 05-skill-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - NaCl box encrypt/decrypt with Ed25519-to-X25519 key conversion for message confidentiality
    - Ed25519 detached signatures for delivery confirmation verification
    - Autonomy-based message routing with locked state names (escalated_to_human, read_by_agent)
    - Multiple envelope handler pattern for coexisting ConnectionManager + MessageManager

key-files:
  created:
    - skill/src/message-manager.ts
    - skill/src/message-manager.test.ts
    - skill/src/inbound-router.ts
    - skill/src/inbound-router.test.ts
  modified:
    - skill/src/relay-client.ts
    - skill/src/relay-client.test.ts

key-decisions:
  - "RelayClient.onEnvelope changed from single callback to array of callbacks for ConnectionManager + MessageManager coexistence"
  - "RelayClient.disconnect() disables autoReconnect to prevent reconnection after intentional disconnect"
  - "InboundRouter defaults unknown autonomy levels to full_manual (escalated_to_human) for safety"
  - "getPendingForReview reverses getHistory DESC result to return ASC order (oldest first) for HEARTBEAT.md"

patterns-established:
  - "Multi-handler envelope dispatch: onEnvelope pushes to array, dispatch iterates all handlers"
  - "Reconnection with exponential backoff: delay = min(base * 2^attempt + jitter, maxDelay)"
  - "Autonomy routing pattern: lookup connection autonomyLevel, map to locked state name, update messageStore"

requirements-completed: [CRYP-01, CRYP-05, SKIL-04]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 3 Plan 3: MessageManager, InboundRouter, and RelayClient Reconnection Summary

**NaCl box encrypted messaging with E2E delivery confirmations, autonomy-based inbound routing, and exponential-backoff reconnection**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-27T03:58:21Z
- **Completed:** 2026-02-27T04:03:37Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- MessageManager orchestrates full encrypt/send/receive/decrypt flows using NaCl box with X25519 key derivation from Ed25519 keypairs
- Delivery confirmations are Ed25519-signed by recipient and cryptographically verified by sender before updating message state
- InboundRouter dispatches messages based on connection autonomy: full_manual -> escalated_to_human, full_auto -> read_by_agent
- RelayClient supports multiple onEnvelope handlers (ConnectionManager + MessageManager coexist)
- RelayClient gains auto-reconnection with exponential backoff, jitter, and configurable max attempts
- 112 tests passing across 12 test files (22 new tests added)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement MessageManager for encrypted message send/receive/confirm** - `b68b8eb` (feat)
2. **Task 2: Create InboundRouter tests and add RelayClient reconnection tests** - `17ba572` (feat)

## Files Created/Modified

- `skill/src/message-manager.ts` - Central MessageManager class: sendMessage (encrypt + send), handleIncomingMessage (decrypt + store + route + confirm), handleDeliveryConfirmation (verify + update), setupHandlers (dispatch MESSAGE and DELIVERY_CONFIRM types)
- `skill/src/message-manager.test.ts` - 13 tests: encrypt/send, UUIDv7 ID, outbound store, inactive connection, missing pubkey, auto threadId, threadId inheritance, 60KB limit, decrypt/store inbound, delivery confirm sent, signature verify, forged rejection, multi-handler
- `skill/src/inbound-router.ts` - InboundRouter class: route() maps autonomyLevel to locked state names, getPendingForReview() surfaces escalated_to_human messages, approveMessage() transitions states
- `skill/src/inbound-router.test.ts` - 8 tests: full_manual routing, full_auto routing, unknown sender failure, pending review query, agent_handle approval, human_respond approval, edge cases
- `skill/src/relay-client.ts` - Changed envelopeHandler single callback to envelopeHandlers array, added autoReconnect option, attemptReconnect with exponential backoff, onDisconnect handler
- `skill/src/relay-client.test.ts` - Added multi-handler integration test verifying both handlers receive same envelope via real Go relay

## Decisions Made

- **Multi-handler pattern:** Changed RelayClient.onEnvelope from single callback assignment to array push. This is the minimal change needed for ConnectionManager and MessageManager to coexist without breaking the existing API (callers still call onEnvelope the same way).
- **Disconnect disables reconnect:** RelayClient.disconnect() sets autoReconnect=false before closing, preventing reconnection loops after intentional disconnects.
- **Unknown autonomy defaults to full_manual:** InboundRouter treats any unrecognized autonomy level as full_manual (escalated_to_human) for safety -- new autonomy levels added later will default to human oversight.
- **Pending review ordering:** getPendingForReview() reverses the DESC result from getHistory to return ASC (oldest first), matching the HEARTBEAT.md checklist expectation of processing oldest messages first.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- MessageManager is ready for integration testing in Plan 04 (end-to-end encrypted message flow between two agents via real relay)
- InboundRouter provides the autonomy routing foundation for HEARTBEAT.md integration
- RelayClient reconnection ready for offline/store-and-forward scenarios in Phase 4
- All 112 tests pass across 12 test files

## Self-Check: PASSED

All 6 key files verified present. Both task commits (b68b8eb, 17ba572) verified in git log. 112/112 tests passing across 12 test files.
