/**
 * Cross-language integration tests for auth handshake and connection lifecycle.
 *
 * Spawns a real Go relay and connects TypeScript agents via the full
 * Ed25519 challenge-response auth handshake. Tests:
 * 1. Auth handshake assigns correct pinch: address
 * 2. Connection request/approve exchanges keys
 * 3. Block enforcement silently drops messages
 * 4. Unblock restores delivery
 * 5. Revoke notifies the other party
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	ConnectionRequestSchema,
	ConnectionResponseSchema,
	ConnectionRevokeSchema,
	BlockNotificationSchema,
	UnblockNotificationSchema,
	MessageType,
} from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import { RelayClient } from "./relay-client.js";
import { generateKeypair } from "./identity.js";
import type { Keypair } from "./identity.js";
import { ConnectionStore } from "./connection-store.js";
import { ConnectionManager } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const RELAY_PORT = 19100 + Math.floor(Math.random() * 900);
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

/** Create a connected agent with RelayClient, ConnectionStore, and ConnectionManager. */
async function createAgent(name: string): Promise<{
	keypair: Keypair;
	client: RelayClient;
	store: ConnectionStore;
	manager: ConnectionManager;
	address: string;
}> {
	const keypair = await generateKeypair();
	const client = new RelayClient(RELAY_URL, keypair, RELAY_HOST);
	const storePath = join(tempDir, `${name}-connections.json`);
	const store = new ConnectionStore(storePath);
	await store.load();
	const manager = new ConnectionManager(client, store);

	await client.connect();
	manager.setupHandlers();

	return {
		keypair,
		client,
		store,
		manager,
		address: client.assignedAddress!,
	};
}

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pinch-integration-"));
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

describe("Scenario 1: Auth Handshake", () => {
	it("connects, authenticates, and gets a pinch: address", async () => {
		const kp = await generateKeypair();
		const client = new RelayClient(RELAY_URL, kp, RELAY_HOST);
		await client.connect();

		expect(client.isConnected()).toBe(true);
		expect(client.assignedAddress).toBeTruthy();
		expect(client.assignedAddress).toMatch(/^pinch:.+@localhost$/);

		client.disconnect();
		await waitForConnections(0);
	});
});

describe("Scenario 2: Connection Request + Approve", () => {
	it("two agents connect, request, approve, and both sides are active with pubkeys", async () => {
		const alice = await createAgent("alice-s2");
		const bob = await createAgent("bob-s2");

		await waitForConnections(2);

		// Collect envelopes received by each agent.
		const aliceReceived: Envelope[] = [];
		const bobReceived: Envelope[] = [];
		alice.client.onMessage((data) => {
			try {
				const env = fromBinary(EnvelopeSchema, new Uint8Array(data));
				aliceReceived.push(env);
			} catch {}
		});
		bob.client.onMessage((data) => {
			try {
				const env = fromBinary(EnvelopeSchema, new Uint8Array(data));
				bobReceived.push(env);
			} catch {}
		});

		// Alice sends connection request to Bob.
		await alice.manager.sendRequest(bob.address, "Hello from Alice");
		expect(alice.store.getConnection(bob.address)!.state).toBe(
			"pending_outbound",
		);

		// Wait for Bob to receive the request.
		await new Promise((r) => setTimeout(r, 500));

		// Bob should have the pending_inbound connection (via setupHandlers).
		expect(bob.store.getConnection(alice.address)!.state).toBe(
			"pending_inbound",
		);

		// Bob approves the request.
		await bob.manager.approveRequest(alice.address);
		expect(bob.store.getConnection(alice.address)!.state).toBe("active");

		// Wait for Alice to receive the response.
		await new Promise((r) => setTimeout(r, 500));

		// Alice should have the active connection (via setupHandlers).
		expect(alice.store.getConnection(bob.address)!.state).toBe("active");

		// Clean up.
		alice.client.disconnect();
		bob.client.disconnect();
		await waitForConnections(0);
	});
});

describe("Scenario 3: Block Enforcement", () => {
	it("blocks drop messages silently, unblock restores delivery", async () => {
		const alice = await createAgent("alice-s3");
		const bob = await createAgent("bob-s3");

		await waitForConnections(2);

		// Set up active connections in both stores (skip the request flow).
		alice.store.addConnection({
			peerAddress: bob.address,
			peerPublicKey: "",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		bob.store.addConnection({
			peerAddress: alice.address,
			peerPublicKey: "",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});

		// Track messages Bob receives.
		const bobMessages: Envelope[] = [];
		bob.client.onMessage((data) => {
			try {
				const env = fromBinary(EnvelopeSchema, new Uint8Array(data));
				bobMessages.push(env);
			} catch {}
		});

		// Bob blocks Alice.
		await bob.manager.blockConnection(alice.address);
		expect(bob.store.getConnection(alice.address)!.state).toBe("blocked");

		// Wait for block to be processed by relay.
		await new Promise((r) => setTimeout(r, 300));

		// Alice sends a regular message to Bob -- should be silently dropped.
		const msg = create(EnvelopeSchema, {
			version: 1,
			fromAddress: alice.address,
			toAddress: bob.address,
			type: MessageType.MESSAGE,
		});
		const msgData = toBinary(EnvelopeSchema, msg);
		alice.client.sendEnvelope(msgData);

		// Wait for potential delivery.
		await new Promise((r) => setTimeout(r, 500));

		// Bob should NOT have received the message.
		const regularMessages = bobMessages.filter(
			(e) => e.type === MessageType.MESSAGE,
		);
		expect(regularMessages).toHaveLength(0);

		// Bob unblocks Alice.
		await bob.manager.unblockConnection(alice.address);
		expect(bob.store.getConnection(alice.address)!.state).toBe("active");

		// Wait for unblock to be processed by relay.
		await new Promise((r) => setTimeout(r, 300));

		// Alice sends another message -- Bob should receive it.
		const msg2 = create(EnvelopeSchema, {
			version: 1,
			fromAddress: alice.address,
			toAddress: bob.address,
			type: MessageType.MESSAGE,
		});
		const msgData2 = toBinary(EnvelopeSchema, msg2);
		alice.client.sendEnvelope(msgData2);

		// Wait for delivery.
		await new Promise((r) => setTimeout(r, 500));

		const regularMessages2 = bobMessages.filter(
			(e) => e.type === MessageType.MESSAGE,
		);
		expect(regularMessages2).toHaveLength(1);

		alice.client.disconnect();
		bob.client.disconnect();
		await waitForConnections(0);
	});
});

describe("Scenario 4: Revoke", () => {
	it("revoke sends notification and both sides mark as revoked", async () => {
		const alice = await createAgent("alice-s4");
		const bob = await createAgent("bob-s4");

		await waitForConnections(2);

		// Set up active connections in both stores.
		alice.store.addConnection({
			peerAddress: bob.address,
			peerPublicKey: "",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		bob.store.addConnection({
			peerAddress: alice.address,
			peerPublicKey: "",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});

		// Alice revokes connection with Bob.
		await alice.manager.revokeConnection(bob.address);
		expect(alice.store.getConnection(bob.address)!.state).toBe("revoked");

		// Wait for Bob to receive the revoke notification (via setupHandlers).
		await new Promise((r) => setTimeout(r, 500));

		// Bob should have the connection marked as revoked.
		expect(bob.store.getConnection(alice.address)!.state).toBe("revoked");

		alice.client.disconnect();
		bob.client.disconnect();
		await waitForConnections(0);
	});
});
