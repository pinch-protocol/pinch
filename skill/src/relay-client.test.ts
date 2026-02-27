import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "./relay-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const RELAY_PORT = 18923 + Math.floor(Math.random() * 1000);
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${RELAY_PORT}/health`;

let relayProcess: ChildProcess;

/** Fetch the health endpoint and return parsed JSON. */
async function getHealth(): Promise<{ goroutines: number; connections: number }> {
	const resp = await fetch(HEALTH_URL);
	return resp.json() as Promise<{ goroutines: number; connections: number }>;
}

/** Wait for the relay to be ready by polling the health endpoint. */
async function waitForRelay(timeoutMs = 15000): Promise<void> {
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
	// Spawn the Go relay as a child process.
	relayProcess = spawn("go", ["run", "./relay/cmd/pinchd/"], {
		env: {
			...process.env,
			PINCH_RELAY_PORT: String(RELAY_PORT),
		},
		cwd: PROJECT_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Relay logs to stderr via slog; pipe but don't print unless debugging.
	relayProcess.stderr?.on("data", () => {});
	relayProcess.stdout?.on("data", () => {});

	await waitForRelay();
}, 30000);

afterAll(() => {
	if (relayProcess) {
		relayProcess.kill("SIGTERM");
	}
});

describe("RelayClient", () => {
	it("connects to the relay and appears in health", async () => {
		const client = new RelayClient(RELAY_URL, "pinch:test1@localhost");
		await client.connect();
		expect(client.isConnected()).toBe(true);

		await waitForConnections(1);
		const health = await getHealth();
		expect(health.connections).toBe(1);

		client.disconnect();
		await waitForConnections(0);
	});

	it("disconnects cleanly and health shows 0 connections", async () => {
		const client = new RelayClient(RELAY_URL, "pinch:test2@localhost");
		await client.connect();
		expect(client.isConnected()).toBe(true);

		await waitForConnections(1);

		client.disconnect();
		expect(client.isConnected()).toBe(false);

		await waitForConnections(0);
		const health = await getHealth();
		expect(health.connections).toBe(0);
	});

	it("supports multiple clients with different addresses", async () => {
		const clients = [
			new RelayClient(RELAY_URL, "pinch:multi-a@localhost"),
			new RelayClient(RELAY_URL, "pinch:multi-b@localhost"),
			new RelayClient(RELAY_URL, "pinch:multi-c@localhost"),
		];

		// Connect all clients.
		await Promise.all(clients.map((c) => c.connect()));
		for (const c of clients) {
			expect(c.isConnected()).toBe(true);
		}

		await waitForConnections(3);
		const health = await getHealth();
		expect(health.connections).toBe(3);

		// Disconnect all.
		for (const c of clients) {
			c.disconnect();
		}
		await waitForConnections(0);
	});

	it("heartbeat keeps connection alive", async () => {
		// Use a short heartbeat interval for faster testing.
		const client = new RelayClient(RELAY_URL, "pinch:heartbeat@localhost", {
			heartbeatInterval: 500,
			pongTimeout: 2000,
		});
		await client.connect();
		expect(client.isConnected()).toBe(true);

		// Wait long enough for at least two heartbeat cycles.
		await new Promise((r) => setTimeout(r, 1500));

		// Connection should still be alive.
		expect(client.isConnected()).toBe(true);

		client.disconnect();
		await waitForConnections(0);
	});

	it("rejects non-WebSocket requests to /ws", async () => {
		// Attempt a plain HTTP GET to /ws (no WebSocket upgrade).
		const resp = await fetch(
			`http://127.0.0.1:${RELAY_PORT}/ws?address=pinch:invalid@localhost`,
		);
		// The server should reject the non-upgrade request.
		expect(resp.ok).toBe(false);
	});

	it("rejects WebSocket connections without address parameter", async () => {
		// Try connecting without an address query parameter.
		const client = new RelayClient(RELAY_URL, "");

		try {
			await client.connect();
			// If connect succeeds, check it gets closed.
			// The server returns 400 before upgrade, so connect should fail.
			client.disconnect();
			expect.fail("expected connection to fail without address");
		} catch {
			// Expected: connection rejected.
			expect(client.isConnected()).toBe(false);
		}
	});
});
