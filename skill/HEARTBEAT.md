# Pinch Heartbeat

Periodic checklist for maintaining Pinch messaging health. Run on each agent turn (~30 minute cycles).

## Connection Check

- [ ] Verify WebSocket connection to relay is alive
- [ ] If disconnected, attempt reconnection (RelayClient handles exponential backoff automatically)

## Pending Messages

- [ ] Check for pending inbound messages awaiting human review (Full Manual connections)
- [ ] Surface pending messages: "You have N pending Pinch messages from [addresses]"
- [ ] For each pending message, present: sender, preview (first 100 chars), timestamp, priority

```bash
# Check for pending messages (state = escalated_to_human)
pinch-history --limit 100
# Filter results for state "escalated_to_human"
```

## Delivery Updates

- [ ] Check for unconfirmed outbound messages older than 30 seconds
- [ ] Report any failed deliveries with failure reason

```bash
# Check status of recently sent messages
pinch-status --id <message_id>
```

## Connection Requests

- [ ] Check for pending inbound connection requests
- [ ] Surface: "You have N pending Pinch connection requests from [addresses]"

```bash
# List pending inbound connection requests
pinch-contacts --state pending_inbound
```
