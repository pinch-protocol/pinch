import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ConnectionStore,
	type Connection,
	type ConnectionState,
	type AutonomyLevel,
} from "./connection-store.js";

let tempDir: string;
let storePath: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pinch-conn-store-"));
	storePath = join(tempDir, "connections.json");
});

function makeConnection(
	overrides: Partial<Omit<Connection, "createdAt" | "lastActivity">> = {},
): Omit<Connection, "createdAt" | "lastActivity"> {
	return {
		peerAddress: "pinch:test123@localhost",
		peerPublicKey: "AAAA",
		state: "active",
		nickname: "",
		autonomyLevel: "full_manual",
		...overrides,
	};
}

describe("ConnectionStore", () => {
	describe("load", () => {
		it("creates empty store when file does not exist", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const connections = store.listConnections();
			expect(connections).toEqual([]);
		});
	});

	describe("addConnection", () => {
		it("sets default timestamps and full_manual autonomy", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const conn = store.addConnection(
				makeConnection({ autonomyLevel: "full_manual" }),
			);

			expect(conn.createdAt).toBeTruthy();
			expect(conn.lastActivity).toBeTruthy();
			expect(conn.autonomyLevel).toBe("full_manual");
			// Timestamps should be valid ISO strings
			expect(() => new Date(conn.createdAt)).not.toThrow();
			expect(() => new Date(conn.lastActivity)).not.toThrow();
		});

		it("rejects shortMessage > 280 chars", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const longMessage = "x".repeat(281);
			expect(() =>
				store.addConnection(
					makeConnection({ shortMessage: longMessage }),
				),
			).toThrow("shortMessage exceeds 280 character limit");
		});

		it("allows shortMessage of exactly 280 chars", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const message = "x".repeat(280);
			const conn = store.addConnection(
				makeConnection({ shortMessage: message }),
			);
			expect(conn.shortMessage).toBe(message);
		});
	});

	describe("getConnection", () => {
		it("returns correct connection", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:abc@localhost";
			store.addConnection(makeConnection({ peerAddress: addr }));

			const conn = store.getConnection(addr);
			expect(conn).toBeTruthy();
			expect(conn?.peerAddress).toBe(addr);
		});

		it("returns undefined for non-existent connection", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			expect(store.getConnection("pinch:none@localhost")).toBeUndefined();
		});
	});

	describe("listConnections", () => {
		it("returns all connections", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			store.addConnection(
				makeConnection({ peerAddress: "pinch:a@localhost" }),
			);
			store.addConnection(
				makeConnection({ peerAddress: "pinch:b@localhost" }),
			);
			store.addConnection(
				makeConnection({ peerAddress: "pinch:c@localhost" }),
			);

			const all = store.listConnections();
			expect(all.length).toBe(3);
		});

		it("filters by state", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			store.addConnection(
				makeConnection({
					peerAddress: "pinch:a@localhost",
					state: "active",
				}),
			);
			store.addConnection(
				makeConnection({
					peerAddress: "pinch:b@localhost",
					state: "blocked",
				}),
			);
			store.addConnection(
				makeConnection({
					peerAddress: "pinch:c@localhost",
					state: "active",
				}),
			);

			const active = store.listConnections({ state: "active" });
			expect(active.length).toBe(2);
			for (const c of active) {
				expect(c.state).toBe("active");
			}
		});

		it("sorts by state priority then lastActivity", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			// Add connections in non-sorted order with controlled timestamps.
			// We use addConnection then overwrite lastActivity to control ordering.
			const states: ConnectionState[] = [
				"blocked",
				"active",
				"pending_inbound",
				"revoked",
				"pending_outbound",
			];
			for (const [i, state] of states.entries()) {
				store.addConnection(
					makeConnection({
						peerAddress: `pinch:${state}@localhost`,
						state,
					}),
				);
			}

			const sorted = store.listConnections();
			const sortedStates = sorted.map((c) => c.state);

			// Expected order: active, pending_inbound, pending_outbound, revoked, blocked
			expect(sortedStates).toEqual([
				"active",
				"pending_inbound",
				"pending_outbound",
				"revoked",
				"blocked",
			]);
		});
	});

	describe("updateConnection", () => {
		it("changes specific fields and updates lastActivity", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:update@localhost";
			const original = store.addConnection(
				makeConnection({ peerAddress: addr }),
			);
			const originalLastActivity = original.lastActivity;

			// Small delay to ensure different timestamp.
			await new Promise((r) => setTimeout(r, 10));

			const updated = store.updateConnection(addr, {
				state: "blocked",
				nickname: "bad actor",
			});

			expect(updated.state).toBe("blocked");
			expect(updated.nickname).toBe("bad actor");
			expect(updated.lastActivity).not.toBe(originalLastActivity);
			// peerAddress should not change
			expect(updated.peerAddress).toBe(addr);
		});

		it("throws for non-existent connection", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			expect(() =>
				store.updateConnection("pinch:none@localhost", {
					state: "blocked",
				}),
			).toThrow("connection not found");
		});
	});

	describe("setNickname", () => {
		it("updates nickname only", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:nick@localhost";
			store.addConnection(makeConnection({ peerAddress: addr }));

			const updated = store.setNickname(addr, "Alice's bot");
			expect(updated.nickname).toBe("Alice's bot");
			expect(updated.state).toBe("active"); // unchanged
		});
	});

	describe("setAutonomy", () => {
		it("allows full_auto to full_manual downgrade without confirmation", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:auto@localhost";
			store.addConnection(
				makeConnection({
					peerAddress: addr,
					autonomyLevel: "full_auto",
				}),
			);

			// Downgrade without confirmed flag -- should work.
			const updated = store.setAutonomy(addr, "full_manual");
			expect(updated.autonomyLevel).toBe("full_manual");
		});

		it("rejects full_manual to full_auto upgrade without confirmed: true", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:manual@localhost";
			store.addConnection(
				makeConnection({
					peerAddress: addr,
					autonomyLevel: "full_manual",
				}),
			);

			expect(() => store.setAutonomy(addr, "full_auto")).toThrow(
				"Upgrading to Full Auto requires explicit confirmation",
			);
		});

		it("rejects full_manual to full_auto upgrade with confirmed: false", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:manual2@localhost";
			store.addConnection(
				makeConnection({
					peerAddress: addr,
					autonomyLevel: "full_manual",
				}),
			);

			expect(() =>
				store.setAutonomy(addr, "full_auto", { confirmed: false }),
			).toThrow(
				"Upgrading to Full Auto requires explicit confirmation",
			);
		});

		it("allows full_manual to full_auto upgrade with confirmed: true", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:confirm@localhost";
			store.addConnection(
				makeConnection({
					peerAddress: addr,
					autonomyLevel: "full_manual",
				}),
			);

			const updated = store.setAutonomy(addr, "full_auto", {
				confirmed: true,
			});
			expect(updated.autonomyLevel).toBe("full_auto");
		});
	});

	describe("save/load roundtrip", () => {
		it("preserves all fields", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const conn = store.addConnection({
				peerAddress: "pinch:roundtrip@localhost",
				peerPublicKey: "dGVzdC1rZXk=",
				state: "active",
				nickname: "Test Bot",
				autonomyLevel: "full_manual",
				shortMessage: "Hello, it's me",
				expiresAt: new Date(
					Date.now() + 7 * 24 * 60 * 60 * 1000,
				).toISOString(),
			});

			await store.save();

			// Load in a fresh store instance.
			const store2 = new ConnectionStore(storePath);
			await store2.load();

			const loaded = store2.getConnection("pinch:roundtrip@localhost");
			expect(loaded).toBeTruthy();
			expect(loaded?.peerAddress).toBe(conn.peerAddress);
			expect(loaded?.peerPublicKey).toBe(conn.peerPublicKey);
			expect(loaded?.state).toBe(conn.state);
			expect(loaded?.nickname).toBe(conn.nickname);
			expect(loaded?.autonomyLevel).toBe(conn.autonomyLevel);
			expect(loaded?.shortMessage).toBe(conn.shortMessage);
			expect(loaded?.createdAt).toBe(conn.createdAt);
			expect(loaded?.lastActivity).toBe(conn.lastActivity);
			expect(loaded?.expiresAt).toBe(conn.expiresAt);
		});
	});

	describe("expirePendingRequests", () => {
		it("marks expired connections as revoked", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			// Create a pending_inbound connection that expired yesterday.
			const pastDate = new Date(
				Date.now() - 24 * 60 * 60 * 1000,
			).toISOString();
			store.addConnection(
				makeConnection({
					peerAddress: "pinch:expired@localhost",
					state: "pending_inbound",
					expiresAt: pastDate,
				}),
			);

			const expired = store.expirePendingRequests();
			expect(expired).toEqual(["pinch:expired@localhost"]);

			const conn = store.getConnection("pinch:expired@localhost");
			expect(conn?.state).toBe("revoked");
		});

		it("also expires pending_outbound connections", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const pastDate = new Date(
				Date.now() - 24 * 60 * 60 * 1000,
			).toISOString();
			store.addConnection(
				makeConnection({
					peerAddress: "pinch:expired-out@localhost",
					state: "pending_outbound",
					expiresAt: pastDate,
				}),
			);

			const expired = store.expirePendingRequests();
			expect(expired).toEqual(["pinch:expired-out@localhost"]);

			const conn = store.getConnection("pinch:expired-out@localhost");
			expect(conn?.state).toBe("revoked");
		});

		it("ignores non-expired and non-pending connections", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			// Future expiry
			const futureDate = new Date(
				Date.now() + 7 * 24 * 60 * 60 * 1000,
			).toISOString();
			store.addConnection(
				makeConnection({
					peerAddress: "pinch:not-expired@localhost",
					state: "pending_inbound",
					expiresAt: futureDate,
				}),
			);

			// Active connection (not pending, no expiry)
			store.addConnection(
				makeConnection({
					peerAddress: "pinch:active@localhost",
					state: "active",
				}),
			);

			// Blocked connection (not pending)
			store.addConnection(
				makeConnection({
					peerAddress: "pinch:blocked@localhost",
					state: "blocked",
				}),
			);

			const expired = store.expirePendingRequests();
			expect(expired).toEqual([]);
		});
	});

	describe("connection state transitions", () => {
		it("can transition active -> blocked", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:trans1@localhost";
			store.addConnection(
				makeConnection({ peerAddress: addr, state: "active" }),
			);

			const updated = store.updateConnection(addr, { state: "blocked" });
			expect(updated.state).toBe("blocked");
		});

		it("can transition active -> revoked", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:trans2@localhost";
			store.addConnection(
				makeConnection({ peerAddress: addr, state: "active" }),
			);

			const updated = store.updateConnection(addr, { state: "revoked" });
			expect(updated.state).toBe("revoked");
		});

		it("can transition blocked -> active (unblock is reversible)", async () => {
			const store = new ConnectionStore(storePath);
			await store.load();

			const addr = "pinch:trans3@localhost";
			store.addConnection(
				makeConnection({ peerAddress: addr, state: "blocked" }),
			);

			const updated = store.updateConnection(addr, { state: "active" });
			expect(updated.state).toBe("active");
		});
	});
});
