/**
 * Cross-language integration tests for encrypted message delivery.
 *
 * Spawns a real Go relay and connects two TypeScript agents via the full
 * Ed25519 challenge-response auth handshake. Validates:
 * 1. Full encrypted message roundtrip (A sends to B, B decrypts)
 * 2. Delivery confirmation roundtrip (B confirms to A, A verifies)
 * 3. Full Manual routing stores message as escalated_to_human
 * 4. Message size limit enforced client-side
 * 5. Message relay latency under 500ms
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RelayClient } from "./relay-client.js";
import { generateKeypair } from "./identity.js";
import type { Keypair } from "./identity.js";
import { ConnectionStore } from "./connection-store.js";
import { ConnectionManager } from "./connection.js";
import { MessageStore } from "./message-store.js";
import { MessageManager } from "./message-manager.js";
import { InboundRouter } from "./inbound-router.js";
import { ActivityFeed } from "./autonomy/activity-feed.js";
import { PermissionsEnforcer } from "./autonomy/permissions-enforcer.js";
import { NoOpPolicyEvaluator } from "./autonomy/policy-evaluator.js";
import { CircuitBreaker } from "./autonomy/circuit-breaker.js";
import { EnforcementPipeline } from "./autonomy/enforcement-pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const RELAY_PORT = 19200 + Math.floor(Math.random() * 800);
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const RELAY_HOST = "localhost";
const HEALTH_URL = `http://127.0.0.1:${RELAY_PORT}/health`;

let relayProcess: ChildProcess;
let tempDir: string;

/** Wait for the relay to be ready by polling the health endpoint. */
async function waitForRelay(timeoutMs = 25000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(HEALTH_URL);
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`relay not ready after ${timeoutMs}ms`);
}

/** Wait until /health reports the expected connection count. */
async function waitForConnections(
	expected: number,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(HEALTH_URL);
			const health = (await resp.json()) as {
				goroutines: number;
				connections: number;
			};
			if (health.connections === expected) return;
		} catch {
			// Relay not ready yet.
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timeout waiting for ${expected} connections`);
}

/** Full agent with all components needed for encrypted messaging. */
interface Agent {
	keypair: Keypair;
	client: RelayClient;
	connectionStore: ConnectionStore;
	connectionManager: ConnectionManager;
	messageStore: MessageStore;
	messageManager: MessageManager;
	inboundRouter: InboundRouter;
	address: string;
}

/** Create a connected agent with all components. */
async function createAgent(name: string): Promise<Agent> {
	const keypair = await generateKeypair();
	const client = new RelayClient(RELAY_URL, keypair, RELAY_HOST);

	const connStorePath = join(tempDir, `${name}-connections.json`);
	const connectionStore = new ConnectionStore(connStorePath);
	await connectionStore.load();

	const msgDbPath = join(tempDir, `${name}-messages.db`);
	const messageStore = new MessageStore(msgDbPath);

	const activityFeed = new ActivityFeed(messageStore.getDb());
	const policyEvaluator = new NoOpPolicyEvaluator();
	const permissionsEnforcer = new PermissionsEnforcer(connectionStore, policyEvaluator);
	const circuitBreaker = new CircuitBreaker(connectionStore, activityFeed);
	const inboundRouter = new InboundRouter(connectionStore, messageStore, activityFeed);
	const enforcementPipeline = new EnforcementPipeline(
		permissionsEnforcer,
		circuitBreaker,
		inboundRouter,
		policyEvaluator,
		connectionStore,
		messageStore,
		activityFeed,
	);
	const connectionManager = new ConnectionManager(
		client,
		connectionStore,
		keypair,
	);
	const messageManager = new MessageManager(
		client,
		connectionStore,
		messageStore,
		keypair,
		enforcementPipeline,
	);

	await client.connect();
	connectionManager.setupHandlers();
	messageManager.setupHandlers();
	await messageManager.init();

	return {
		keypair,
		client,
		connectionStore,
		connectionManager,
		messageStore,
		messageManager,
		inboundRouter,
		address: client.assignedAddress!,
	};
}

/** Establish a mutual active connection between two agents. */
async function establishConnection(
	agentA: Agent,
	agentB: Agent,
): Promise<void> {
	// A sends connection request to B.
	await agentA.connectionManager.sendRequest(
		agentB.address,
		"Integration test connection",
	);

	// Wait for B to receive the request.
	await new Promise((r) => setTimeout(r, 500));

	// B approves the request.
	await agentB.connectionManager.approveRequest(agentA.address);

	// Wait for A to receive the response.
	await new Promise((r) => setTimeout(r, 500));

	// Verify both sides are active.
	expect(agentA.connectionStore.getConnection(agentB.address)!.state).toBe(
		"active",
	);
	expect(agentB.connectionStore.getConnection(agentA.address)!.state).toBe(
		"active",
	);
}

/** Clean up an agent's resources. */
function cleanupAgent(agent: Agent): void {
	agent.client.disconnect();
	agent.messageStore.close();
}

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pinch-msg-integration-"));
	const dbPath = join(tempDir, "blocks.db");

	relayProcess = spawn("go", ["run", "./relay/cmd/pinchd/"], {
		env: {
			...process.env,
			PINCH_RELAY_PORT: String(RELAY_PORT),
			PINCH_RELAY_HOST: RELAY_HOST,
			PINCH_RELAY_DB: dbPath,
		},
		cwd: PROJECT_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});

	relayProcess.stderr?.on("data", () => {});
	relayProcess.stdout?.on("data", () => {});

	await waitForRelay();
}, 30000);

afterAll(async () => {
	if (relayProcess) {
		relayProcess.kill("SIGTERM");
	}
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
});

describe("Full encrypted message roundtrip", () => {
	it("A sends encrypted message to B, B decrypts and verifies plaintext", async () => {
		const alice = await createAgent("alice-msg");
		const bob = await createAgent("bob-msg");
		await waitForConnections(2);

		await establishConnection(alice, bob);

		// Alice sends an encrypted message to Bob.
		const messageId = await alice.messageManager.sendMessage({
			recipient: bob.address,
			body: "Hello Bob, this is a secret message!",
			priority: "normal",
		});

		expect(messageId).toBeTruthy();

		// Wait for Bob to receive, decrypt, and store the message.
		await new Promise((r) => setTimeout(r, 1000));

		// Verify Bob has the decrypted message.
		const bobMessages = bob.messageStore.getHistory({
			connectionAddress: alice.address,
		});
		expect(bobMessages.length).toBeGreaterThanOrEqual(1);
		const received = bobMessages.find((m) => m.id === messageId);
		expect(received).toBeDefined();
		expect(received!.body).toBe("Hello Bob, this is a secret message!");
		expect(received!.direction).toBe("inbound");

		cleanupAgent(alice);
		cleanupAgent(bob);
		await waitForConnections(0);
	});
});

describe("Delivery confirmation roundtrip", () => {
	it("B sends delivery confirmation, A verifies and updates state to delivered", async () => {
		const alice = await createAgent("alice-confirm");
		const bob = await createAgent("bob-confirm");
		await waitForConnections(2);

		await establishConnection(alice, bob);

		// Alice sends message.
		const messageId = await alice.messageManager.sendMessage({
			recipient: bob.address,
			body: "Confirm this please",
		});

		// Verify Alice's message starts as "sent".
		const sentMsg = alice.messageStore.getMessage(messageId);
		expect(sentMsg!.state).toBe("sent");

		// Wait for full roundtrip: send -> decrypt -> delivery confirm -> verify.
		await new Promise((r) => setTimeout(r, 1500));

		// Alice's message state should be updated to "delivered" after
		// receiving Bob's signed delivery confirmation.
		const updatedMsg = alice.messageStore.getMessage(messageId);
		expect(updatedMsg!.state).toBe("delivered");

		cleanupAgent(alice);
		cleanupAgent(bob);
		await waitForConnections(0);
	});
});

describe("Full Manual routing", () => {
	it("message from full_manual connection is stored with escalated_to_human state", async () => {
		const alice = await createAgent("alice-manual");
		const bob = await createAgent("bob-manual");
		await waitForConnections(2);

		await establishConnection(alice, bob);

		// Bob's connection to Alice defaults to full_manual (the default).
		const bobConn = bob.connectionStore.getConnection(alice.address);
		expect(bobConn!.autonomyLevel).toBe("full_manual");

		// Alice sends message to Bob.
		const messageId = await alice.messageManager.sendMessage({
			recipient: bob.address,
			body: "This should be escalated to human",
		});

		// Wait for Bob to receive and route.
		await new Promise((r) => setTimeout(r, 1000));

		// Bob's inbound router should have set the state to escalated_to_human.
		const bobMsg = bob.messageStore.getMessage(messageId);
		expect(bobMsg).toBeDefined();
		expect(bobMsg!.state).toBe("escalated_to_human");

		// Verify it appears in pending for review.
		const pending = bob.inboundRouter.getPendingForReview();
		const found = pending.find((m) => m.id === messageId);
		expect(found).toBeDefined();

		cleanupAgent(alice);
		cleanupAgent(bob);
		await waitForConnections(0);
	});
});

describe("Message size limit", () => {
	it("sending >60KB body throws client-side error", async () => {
		const alice = await createAgent("alice-size");
		const bob = await createAgent("bob-size");
		await waitForConnections(2);

		await establishConnection(alice, bob);

		// 61KB body should exceed the 60KB envelope limit.
		const largeBody = "x".repeat(61 * 1024);

		await expect(
			alice.messageManager.sendMessage({
				recipient: bob.address,
				body: largeBody,
			}),
		).rejects.toThrow("message too large");

		cleanupAgent(alice);
		cleanupAgent(bob);
		await waitForConnections(0);
	});
});

describe("Message relay latency", () => {
	it("full send-receive roundtrip completes in under 500ms", async () => {
		const alice = await createAgent("alice-latency");
		const bob = await createAgent("bob-latency");
		await waitForConnections(2);

		await establishConnection(alice, bob);

		const start = Date.now();

		const messageId = await alice.messageManager.sendMessage({
			recipient: bob.address,
			body: "Latency test message",
		});

		// Poll for Bob receiving the message (tight loop, not sleep).
		const deadline = Date.now() + 500;
		let received = false;
		while (Date.now() < deadline) {
			const msg = bob.messageStore.getMessage(messageId);
			if (msg) {
				received = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 10));
		}

		const elapsed = Date.now() - start;

		expect(received).toBe(true);
		expect(elapsed).toBeLessThan(500);

		cleanupAgent(alice);
		cleanupAgent(bob);
		await waitForConnections(0);
	});
});
