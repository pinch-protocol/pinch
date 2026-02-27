#!/bin/bash
set -euo pipefail

# Cross-language integration test: Auth handshake and connection lifecycle
#
# Tests the full auth + connection flow between TypeScript agents
# and the Go relay:
# 1. Auth handshake: TS agents authenticate to Go relay via Ed25519 challenge-response
# 2. Connection request: Agent A requests connection to Agent B
# 3. Connection approve: Agent B approves, both sides exchange keys
# 4. Block enforcement: Relay silently drops messages from blocked agents
# 5. Unblock: Delivery resumes after unblock
# 6. Revoke: Other party receives notification
#
# Uses vitest to run the TypeScript integration test against a live Go relay.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo ""
echo "=== Cross-Language Auth & Connection Integration Tests ==="
echo ""

# Step 1: Verify Go relay builds.
echo "Building Go relay..."
(cd "$ROOT_DIR" && go build -o /dev/null ./relay/cmd/pinchd/)
echo "  Build: OK"

# Step 2: Run the TypeScript integration tests (which spawn the Go relay).
# The relay-client.test.ts already tests auth handshake.
# The connection.integration.test.ts tests the full connection lifecycle.
echo ""
echo "Running integration tests..."
cd "$ROOT_DIR/skill"
pnpm test -- --reporter=verbose src/connection.integration.test.ts 2>&1

echo ""
echo "=== All cross-language auth & connection tests passed! ==="
exit 0
