/**
 * Cross-language integration tests for store-and-forward message delivery.
 *
 * Spawns a real Go relay and connects two TypeScript agents via the full
 * Ed25519 challenge-response auth handshake. Validates:
 * 1. Offline agent receives queued messages on reconnect in order
 * 2. Sender receives delivery confirmations with was_stored=true
 * 3. Queue full returns QueueFull error to sender
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fromBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	MessageType,
} from "../../gen/ts/pinch/v1/envelope_pb.js";
import type { Envelope } from "../../gen/ts/pinch/v1/envelope_pb.js";
import { RelayClient } from "../../skill/src/relay-client.js";
import { generateKeypair } from "../../skill/src/identity.js";
import type { Keypair } from "../../skill/src/identity.js";
import { ConnectionStore } from "../../skill/src/connection-store.js";
import { ConnectionManager } from "../../skill/src/connection.js";
import { MessageStore } from "../../skill/src/message-store.js";
import { MessageManager } from "../../skill/src/message-manager.js";
import { InboundRouter } from "../../skill/src/inbound-router.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const RELAY_PORT = 19800 + Math.floor(Math.random() * 200);
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
	/** Envelopes received by the onEnvelope handler. */
	receivedEnvelopes: Envelope[];
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

	const inboundRouter = new InboundRouter(connectionStore, messageStore);
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
		inboundRouter,
	);

	const receivedEnvelopes: Envelope[] = [];

	await client.connect();
	connectionManager.setupHandlers();
	messageManager.setupHandlers();
	await messageManager.init();

	// Track all envelopes for test assertions.
	client.onEnvelope((env: Envelope) => {
		receivedEnvelopes.push(env);
	});

	return {
		keypair,
		client,
		connectionStore,
		connectionManager,
		messageStore,
		messageManager,
		inboundRouter,
		address: client.assignedAddress!,
		receivedEnvelopes,
	};
}

/** Establish a mutual active connection between two agents. */
async function establishConnection(
	agentA: Agent,
	agentB: Agent,
): Promise<void> {
	await agentA.connectionManager.sendRequest(
		agentB.address,
		"Integration test connection",
	);
	await new Promise((r) => setTimeout(r, 500));
	await agentB.connectionManager.approveRequest(agentA.address);
	await new Promise((r) => setTimeout(r, 500));

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

describe("Store-and-forward integration tests", () => {
	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-sf-integration-"));
		const dbPath = join(tempDir, "relay.db");

		relayProcess = spawn("go", ["run", "./relay/cmd/pinchd/"], {
			env: {
				...process.env,
				PINCH_RELAY_PORT: String(RELAY_PORT),
				PINCH_RELAY_HOST: RELAY_HOST,
				PINCH_RELAY_DB: dbPath,
				PINCH_RELAY_QUEUE_MAX: "1000",
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

	it("offline agent receives queued messages on reconnect", async () => {
		const alice = await createAgent("alice-sf");
		const bob = await createAgent("bob-sf");
		await waitForConnections(2);

		await establishConnection(alice, bob);

		// Disconnect Bob.
		bob.client.disconnect();
		await waitForConnections(1);

		// Alice sends 3 messages to offline Bob.
		const sentIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const id = await alice.messageManager.sendMessage({
				recipient: bob.address,
				body: `Queued message ${i + 1}`,
			});
			sentIds.push(id);
		}

		// Wait for enqueue.
		await new Promise((r) => setTimeout(r, 500));

		// Reconnect Bob with a new RelayClient (simulating reconnect).
		const bobClient2 = new RelayClient(RELAY_URL, bob.keypair, RELAY_HOST);
		const bobMsgDb2 = join(tempDir, "bob-sf-reconnect-messages.db");
		const bobMsgStore2 = new MessageStore(bobMsgDb2);
		const bobConnStore2 = new ConnectionStore(
			join(tempDir, "bob-sf-reconnect-connections.json"),
		);
		await bobConnStore2.load();

		// Copy connection data so Bob2 knows Alice.
		const aliceConn = bob.connectionStore.getConnection(alice.address);
		if (aliceConn) {
			bobConnStore2.addConnection({
				peerAddress: alice.address,
				peerPublicKey: aliceConn.peerPublicKey,
				state: "active",
				nickname: aliceConn.nickname,
				autonomyLevel: aliceConn.autonomyLevel,
			});
		}

		const bobInboundRouter2 = new InboundRouter(bobConnStore2, bobMsgStore2);
		const bobConnMgr2 = new ConnectionManager(
			bobClient2,
			bobConnStore2,
			bob.keypair,
		);
		const bobMsgMgr2 = new MessageManager(
			bobClient2,
			bobConnStore2,
			bobMsgStore2,
			bob.keypair,
			bobInboundRouter2,
		);

		const bob2Envelopes: Envelope[] = [];
		await bobClient2.connect();
		bobConnMgr2.setupHandlers();
		bobMsgMgr2.setupHandlers();
		await bobMsgMgr2.init();

		bobClient2.onEnvelope((env: Envelope) => {
			bob2Envelopes.push(env);
		});

		await waitForConnections(2);

		// Wait for flush to complete and delivery confirmations to arrive.
		await new Promise((r) => setTimeout(r, 3000));

		// Bob should have received the 3 messages (check via message store).
		const bobMessages = bobMsgStore2.getHistory({
			connectionAddress: alice.address,
		});
		expect(bobMessages.length).toBeGreaterThanOrEqual(3);

		// Verify all messages arrived.
		for (const id of sentIds) {
			const msg = bobMsgStore2.getMessage(id);
			expect(msg).toBeDefined();
			expect(msg!.direction).toBe("inbound");
		}

		// Verify messages arrived in order (getHistory returns DESC, so reverse).
		const orderedIds = bobMessages
			.filter((m) => sentIds.includes(m.id))
			.map((m) => m.id)
			.reverse();
		expect(orderedIds).toEqual(sentIds);

		// Check that Alice received delivery confirmations.
		// Give a bit more time for confirmations to arrive.
		await new Promise((r) => setTimeout(r, 1000));

		// Verify Alice's messages are now marked as delivered.
		for (const id of sentIds) {
			const msg = alice.messageStore.getMessage(id);
			expect(msg!.state).toBe("delivered");
		}

		// Clean up.
		bobClient2.disconnect();
		bobMsgStore2.close();
		cleanupAgent(alice);
		bob.messageStore.close();
		await waitForConnections(0);
	}, 30000);
});

describe("Queue full integration test", () => {
	let relayProcess2: ChildProcess;
	let tempDir2: string;
	const RELAY_PORT2 = 19800 + 200 + Math.floor(Math.random() * 200);
	const RELAY_URL2 = `ws://127.0.0.1:${RELAY_PORT2}`;
	const HEALTH_URL2 = `http://127.0.0.1:${RELAY_PORT2}/health`;

	async function waitForRelay2(timeoutMs = 25000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				await fetch(HEALTH_URL2);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		throw new Error(`relay2 not ready after ${timeoutMs}ms`);
	}

	async function waitForConnections2(
		expected: number,
		timeoutMs = 5000,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const resp = await fetch(HEALTH_URL2);
				const health = (await resp.json()) as {
					goroutines: number;
					connections: number;
				};
				if (health.connections === expected) return;
			} catch {
				// Not ready yet.
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`timeout waiting for ${expected} connections on relay2`);
	}

	async function createAgent2(name: string): Promise<Agent> {
		const keypair = await generateKeypair();
		const client = new RelayClient(RELAY_URL2, keypair, RELAY_HOST);

		const connStorePath = join(tempDir2, `${name}-connections.json`);
		const connectionStore = new ConnectionStore(connStorePath);
		await connectionStore.load();

		const msgDbPath = join(tempDir2, `${name}-messages.db`);
		const messageStore = new MessageStore(msgDbPath);

		const inboundRouter = new InboundRouter(connectionStore, messageStore);
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
			inboundRouter,
		);

		const receivedEnvelopes: Envelope[] = [];

		await client.connect();
		connectionManager.setupHandlers();
		messageManager.setupHandlers();
		await messageManager.init();

		client.onEnvelope((env: Envelope) => {
			receivedEnvelopes.push(env);
		});

		return {
			keypair,
			client,
			connectionStore,
			connectionManager,
			messageStore,
			messageManager,
			inboundRouter,
			address: client.assignedAddress!,
			receivedEnvelopes,
		};
	}

	beforeAll(async () => {
		tempDir2 = await mkdtemp(join(tmpdir(), "pinch-qf-integration-"));
		const dbPath = join(tempDir2, "relay.db");

		relayProcess2 = spawn("go", ["run", "./relay/cmd/pinchd/"], {
			env: {
				...process.env,
				PINCH_RELAY_PORT: String(RELAY_PORT2),
				PINCH_RELAY_HOST: RELAY_HOST,
				PINCH_RELAY_DB: dbPath,
				PINCH_RELAY_QUEUE_MAX: "5",
			},
			cwd: PROJECT_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});

		relayProcess2.stderr?.on("data", () => {});
		relayProcess2.stdout?.on("data", () => {});

		await waitForRelay2();
	}, 30000);

	afterAll(async () => {
		if (relayProcess2) {
			relayProcess2.kill("SIGTERM");
		}
		if (tempDir2) {
			await rm(tempDir2, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("queue full returns QueueFull error to sender", async () => {
		const alice = await createAgent2("alice-qf");
		const bob = await createAgent2("bob-qf");
		await waitForConnections2(2);

		await establishConnection(alice, bob);

		// Disconnect Bob.
		bob.client.disconnect();
		await waitForConnections2(1);

		// Alice sends 6 messages (queue cap is 5, so 6th should fail).
		for (let i = 0; i < 6; i++) {
			await alice.messageManager.sendMessage({
				recipient: bob.address,
				body: `Queue test message ${i + 1}`,
			});
		}

		// Wait for all messages to be routed.
		await new Promise((r) => setTimeout(r, 1000));

		// Alice should have received a QueueFull envelope.
		const queueFullEnvelopes = alice.receivedEnvelopes.filter(
			(e) => e.type === MessageType.QUEUE_FULL,
		);
		expect(queueFullEnvelopes.length).toBeGreaterThanOrEqual(1);

		const qf = queueFullEnvelopes[0];
		expect(qf.payload.case).toBe("queueFull");
		if (qf.payload.case === "queueFull") {
			expect(qf.payload.value.recipientAddress).toBe(bob.address);
			expect(qf.payload.value.reason).toContain("full");
		}

		cleanupAgent(alice);
		bob.messageStore.close();
		await waitForConnections2(0);
	}, 30000);
});
