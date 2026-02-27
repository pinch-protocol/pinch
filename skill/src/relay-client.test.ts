import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RelayClient } from "./relay-client.js";
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

/** Fetch the health endpoint and return parsed JSON. */
async function getHealth(): Promise<{
	goroutines: number;
	connections: number;
}> {
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
async function waitForConnections(
	expected: number,
	timeoutMs = 5000,
): Promise<void> {
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
	throw new Error(
		`expected ${expected} connections, got ${health.connections}`,
	);
}

beforeAll(async () => {
	// Use a unique temp directory for the bbolt database to avoid file lock
	// conflicts between test runs.
	tempDbDir = await mkdtemp(join(tmpdir(), "pinch-relay-test-"));
	const dbPath = join(tempDbDir, "blocks.db");

	// Spawn the Go relay as a child process.
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

	// Relay logs to stderr via slog; pipe but don't print unless debugging.
	relayProcess.stderr?.on("data", () => {});
	relayProcess.stdout?.on("data", () => {});

	await waitForRelay();
}, 30000);

afterAll(async () => {
	if (relayProcess) {
		relayProcess.kill("SIGTERM");
	}
	// Clean up temp db directory.
	if (tempDbDir) {
		await rm(tempDbDir, { recursive: true, force: true }).catch(() => {});
	}
});

describe("RelayClient with auth handshake", () => {
	it("connects, authenticates, and gets an assigned address", async () => {
		const kp = await generateKeypair();
		const client = new RelayClient(RELAY_URL, kp, RELAY_HOST);
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
		const kp = await generateKeypair();
		const client = new RelayClient(RELAY_URL, kp, RELAY_HOST);
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
		const keypairs = await Promise.all([
			generateKeypair(),
			generateKeypair(),
			generateKeypair(),
		]);
		const clients = keypairs.map(
			(kp) => new RelayClient(RELAY_URL, kp, RELAY_HOST),
		);

		// Connect all clients.
		await Promise.all(clients.map((c) => c.connect()));
		for (const c of clients) {
			expect(c.isConnected()).toBe(true);
			expect(c.assignedAddress).toBeTruthy();
		}

		// All assigned addresses should be unique.
		const addresses = clients.map((c) => c.assignedAddress);
		const unique = new Set(addresses);
		expect(unique.size).toBe(3);

		await waitForConnections(3);
		const health = await getHealth();
		expect(health.connections).toBe(3);

		// Disconnect all.
		for (const c of clients) {
			c.disconnect();
		}
		await waitForConnections(0);
	});

	it("heartbeat keeps connection alive after auth", async () => {
		const kp = await generateKeypair();
		// Use a short heartbeat interval for faster testing.
		const client = new RelayClient(RELAY_URL, kp, RELAY_HOST, {
			heartbeatInterval: 500,
			pongTimeout: 2000,
		});
		await client.connect();
		expect(client.isConnected()).toBe(true);
		expect(client.assignedAddress).toBeTruthy();

		// Wait long enough for at least two heartbeat cycles.
		await new Promise((r) => setTimeout(r, 1500));

		// Connection should still be alive.
		expect(client.isConnected()).toBe(true);

		client.disconnect();
		await waitForConnections(0);
	});

	it("rejects non-WebSocket requests to /ws", async () => {
		// Attempt a plain HTTP GET to /ws (no WebSocket upgrade).
		const resp = await fetch(`http://127.0.0.1:${RELAY_PORT}/ws`);
		// The server should reject the non-upgrade request.
		expect(resp.ok).toBe(false);
	});

	it("same keypair gets the same assigned address on reconnect", async () => {
		const kp = await generateKeypair();

		const client1 = new RelayClient(RELAY_URL, kp, RELAY_HOST);
		await client1.connect();
		const addr1 = client1.assignedAddress;
		client1.disconnect();
		await waitForConnections(0);

		const client2 = new RelayClient(RELAY_URL, kp, RELAY_HOST);
		await client2.connect();
		const addr2 = client2.assignedAddress;
		client2.disconnect();
		await waitForConnections(0);

		expect(addr1).toBe(addr2);
	});
});
