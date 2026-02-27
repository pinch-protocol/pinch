import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { create, toBinary } from "@bufbuild/protobuf";
import { EnvelopeSchema, MessageType } from "@pinch/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch/proto/pinch/v1/envelope_pb.js";
import WS from "ws";
import { RelayClient } from "./relay-client.js";
import { ensureSodiumReady } from "./crypto.js";
import { generateKeypair } from "./identity.js";
import type { Keypair } from "./identity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const RELAY_PORT = 18923 + Math.floor(Math.random() * 1000);
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const RELAY_HOST = "localhost";
const HEALTH_URL = `http://127.0.0.1:${RELAY_PORT}/health`;

let relayProcess: ChildProcess;
let tempDbDir: string;

async function createClient(
	options?: {
		heartbeatInterval?: number;
		pongTimeout?: number;
		authTimeout?: number;
		autoReconnect?: boolean;
	},
	keypair?: Keypair,
): Promise<RelayClient> {
	const kp = keypair ?? (await generateKeypair());
	return new RelayClient(RELAY_URL, kp, RELAY_HOST, options);
}

/** Fetch the health endpoint and return parsed JSON. */
async function getHealth(): Promise<{ goroutines: number; connections: number }> {
	const resp = await fetch(HEALTH_URL);
	return resp.json() as Promise<{ goroutines: number; connections: number }>;
}

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
async function waitForConnections(expected: number, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const health = await getHealth();
			if (health.connections === expected) return;
		} catch {
			// Relay not ready yet.
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	const health = await getHealth();
	throw new Error(`expected ${expected} connections, got ${health.connections}`);
}

beforeAll(async () => {
	await ensureSodiumReady();

	// Use a unique temp directory for the bbolt database to avoid file lock
	// conflicts between test runs.
	tempDbDir = await mkdtemp(join(tmpdir(), "pinch-relay-test-"));
	const dbPath = join(tempDbDir, "relay.db");

	relayProcess = spawn("go", ["run", "./relay/cmd/pinchd/"], {
		env: {
			...process.env,
			PINCH_RELAY_PORT: String(RELAY_PORT),
			PINCH_RELAY_PUBLIC_HOST: RELAY_HOST,
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
	if (tempDbDir) {
		await rm(tempDbDir, { recursive: true, force: true }).catch(() => {});
	}
});

describe("RelayClient with auth handshake", () => {
	it("connects, authenticates, and gets an assigned address", async () => {
		const client = await createClient();
		await client.connect();

		expect(client.isConnected()).toBe(true);
		expect(client.assignedAddress).toBeTruthy();
		expect(client.assignedAddress).toMatch(/^pinch:.+@localhost$/);

		await waitForConnections(1);
		const health = await getHealth();
		expect(health.connections).toBe(1);

		client.disconnect();
		await waitForConnections(0);
	});

	it("disconnects cleanly and health shows 0 connections", async () => {
		const client = await createClient();
		await client.connect();
		expect(client.isConnected()).toBe(true);

		await waitForConnections(1);

		client.disconnect();
		expect(client.isConnected()).toBe(false);

		await waitForConnections(0);
		const health = await getHealth();
		expect(health.connections).toBe(0);
	});

	it("supports multiple clients with different keypairs", async () => {
		const clients = await Promise.all([createClient(), createClient(), createClient()]);

		await Promise.all(clients.map((c) => c.connect()));
		for (const c of clients) {
			expect(c.isConnected()).toBe(true);
			expect(c.assignedAddress).toBeTruthy();
		}

		const addresses = clients.map((c) => c.assignedAddress);
		const unique = new Set(addresses);
		expect(unique.size).toBe(3);

		await waitForConnections(3);
		const health = await getHealth();
		expect(health.connections).toBe(3);

		for (const c of clients) {
			c.disconnect();
		}
		await waitForConnections(0);
	});

	it("heartbeat keeps connection alive after auth", async () => {
		const client = await createClient({
			heartbeatInterval: 500,
			pongTimeout: 2000,
		});
		await client.connect();
		expect(client.isConnected()).toBe(true);
		expect(client.assignedAddress).toBeTruthy();

		await new Promise((r) => setTimeout(r, 1500));
		expect(client.isConnected()).toBe(true);

		client.disconnect();
		await waitForConnections(0);
	});

	it("rejects non-WebSocket requests to /ws", async () => {
		const resp = await fetch(`http://127.0.0.1:${RELAY_PORT}/ws`);
		expect(resp.ok).toBe(false);
	});

	it("same keypair gets the same assigned address on reconnect", async () => {
		const kp = await generateKeypair();

		const client1 = await createClient(undefined, kp);
		await client1.connect();
		const addr1 = client1.assignedAddress;
		client1.disconnect();
		await waitForConnections(0);

		const client2 = await createClient(undefined, kp);
		await client2.connect();
		const addr2 = client2.assignedAddress;
		client2.disconnect();
		await waitForConnections(0);

		expect(addr1).toBe(addr2);
	});

	it("multiple onEnvelope handlers all receive the same envelope", async () => {
		const sender = await createClient();
		const receiver = await createClient();

		await sender.connect();
		await receiver.connect();
		await waitForConnections(2);

		const received1: Envelope[] = [];
		const received2: Envelope[] = [];

		receiver.onEnvelope((env) => {
			received1.push(env);
		});
		receiver.onEnvelope((env) => {
			received2.push(env);
		});

		const envelope = create(EnvelopeSchema, {
			version: 1,
			fromAddress: sender.assignedAddress!,
			toAddress: receiver.assignedAddress!,
			type: MessageType.HEARTBEAT,
			timestamp: BigInt(Date.now()),
		});
		sender.sendEnvelope(toBinary(EnvelopeSchema, envelope));

		await new Promise((r) => setTimeout(r, 500));

		expect(received1).toHaveLength(1);
		expect(received2).toHaveLength(1);
		expect(received1[0].type).toBe(MessageType.HEARTBEAT);
		expect(received2[0].type).toBe(MessageType.HEARTBEAT);

		sender.disconnect();
		receiver.disconnect();
		await waitForConnections(0);
	});

	it("rejects unauthenticated websocket connections", async () => {
		const ws = new WS(`${RELAY_URL}/ws`);
		const firstServerEvent = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for challenge/close")),
				1000,
			);
			ws.once("message", () => {
				clearTimeout(timer);
				resolve();
			});
			ws.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			ws.once("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});

		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", (err) => reject(err));
		});

		await firstServerEvent;
		await waitForConnections(0, 2000);
		ws.terminate();
	});

	it("rejects duplicate-address connect before reporting connected", async () => {
		const kp = await generateKeypair();
		const primary = await createClient(undefined, kp);
		await primary.connect();
		await waitForConnections(1);

		const duplicate = await createClient({ authTimeout: 3000 }, kp);
		await expect(duplicate.connect()).rejects.toThrow(/address already connected/i);
		expect(duplicate.isConnected()).toBe(false);

		const health = await getHealth();
		expect(health.connections).toBe(1);

		duplicate.disconnect();
		primary.disconnect();
		await waitForConnections(0);
	});
});
