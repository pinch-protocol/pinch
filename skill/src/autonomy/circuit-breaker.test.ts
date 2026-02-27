import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ActivityFeed } from "./activity-feed.js";
import { ConnectionStore } from "../connection-store.js";

describe("CircuitBreaker", () => {
	let tempDir: string;
	let db: DatabaseType;
	let activityFeed: ActivityFeed;
	let connectionStore: ConnectionStore;
	let cb: CircuitBreaker;

	const addr = "pinch:bob@localhost";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-cb-test-"));
		db = new Database(join(tempDir, "test.db"));
		db.pragma("journal_mode = WAL");
		activityFeed = new ActivityFeed(db);
		connectionStore = new ConnectionStore(
			join(tempDir, "connections.json"),
		);
		await connectionStore.load();

		// Add an active connection at notify level (something higher than full_manual)
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "notify",
		});

		// Use low thresholds for testing
		cb = new CircuitBreaker(connectionStore, activityFeed, {
			floodThreshold: 5,
			floodWindowMs: 60_000,
			violationThreshold: 3,
			violationWindowMs: 300_000,
			boundaryProbeThreshold: 2,
			boundaryProbeWindowMs: 600_000,
		});
	});

	afterEach(() => {
		db.close();
	});

	it("single message does not trip circuit breaker", () => {
		cb.recordMessage(addr);

		expect(cb.isTripped(addr)).toBe(false);
		const conn = connectionStore.getConnection(addr)!;
		expect(conn.autonomyLevel).toBe("notify");
	});

	it("messages exceeding flood threshold trip circuit breaker and downgrade to full_manual", () => {
		for (let i = 0; i < 5; i++) {
			cb.recordMessage(addr);
		}

		expect(cb.isTripped(addr)).toBe(true);
		const conn = connectionStore.getConnection(addr)!;
		expect(conn.autonomyLevel).toBe("full_manual");
	});

	it("permission violations exceeding threshold trip circuit breaker", () => {
		for (let i = 0; i < 3; i++) {
			cb.recordViolation(addr, "permission_violation");
		}

		expect(cb.isTripped(addr)).toBe(true);
		const conn = connectionStore.getConnection(addr)!;
		expect(conn.autonomyLevel).toBe("full_manual");
	});

	it("boundary probes exceeding threshold trip circuit breaker", () => {
		for (let i = 0; i < 2; i++) {
			cb.recordViolation(addr, "boundary_probe");
		}

		expect(cb.isTripped(addr)).toBe(true);
		const conn = connectionStore.getConnection(addr)!;
		expect(conn.autonomyLevel).toBe("full_manual");
	});

	it("circuit breaker trip records activity feed event with trigger details", () => {
		for (let i = 0; i < 5; i++) {
			cb.recordMessage(addr);
		}

		const events = activityFeed.getEvents({
			eventType: "circuit_breaker_tripped",
		});
		expect(events).toHaveLength(1);
		expect(events[0].connectionAddress).toBe(addr);
		expect(events[0].badge).toBe("circuit_breaker");

		const details = JSON.parse(events[0].details!);
		expect(details.trigger).toBe("message_flood");
		expect(details.count).toBe(5);
		expect(details.threshold).toBe(5);
		expect(details.windowMs).toBe(60_000);
	});

	it("circuit breaker trip sets circuitBreakerTripped flag on connection", () => {
		for (let i = 0; i < 5; i++) {
			cb.recordMessage(addr);
		}

		const conn = connectionStore.getConnection(addr)!;
		expect(conn.circuitBreakerTripped).toBe(true);
	});

	it("isTripped returns true for tripped connection", () => {
		expect(cb.isTripped(addr)).toBe(false);

		for (let i = 0; i < 5; i++) {
			cb.recordMessage(addr);
		}

		expect(cb.isTripped(addr)).toBe(true);
	});

	it("old events are pruned (events outside window don't count toward threshold)", () => {
		// Create a circuit breaker with a very short window
		const shortCb = new CircuitBreaker(connectionStore, activityFeed, {
			floodThreshold: 5,
			floodWindowMs: 50, // 50ms window
			violationThreshold: 3,
			violationWindowMs: 50,
			boundaryProbeThreshold: 2,
			boundaryProbeWindowMs: 50,
		});

		// Record 3 messages
		for (let i = 0; i < 3; i++) {
			shortCb.recordMessage(addr);
		}

		expect(shortCb.isTripped(addr)).toBe(false);

		// Wait for events to expire, then record 2 more (total within window: 2, below threshold of 5)
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				shortCb.recordMessage(addr);
				shortCb.recordMessage(addr);

				// Should still not be tripped because the 3 older events expired
				expect(shortCb.isTripped(addr)).toBe(false);
				resolve();
			}, 80);
		});
	});

	it("human re-upgrade clears circuitBreakerTripped flag", () => {
		// Trip the circuit breaker
		for (let i = 0; i < 5; i++) {
			cb.recordMessage(addr);
		}
		expect(cb.isTripped(addr)).toBe(true);

		// Human manually re-upgrades via setAutonomy
		connectionStore.setAutonomy(addr, "notify");

		// circuitBreakerTripped should be cleared
		expect(cb.isTripped(addr)).toBe(false);
		const conn = connectionStore.getConnection(addr)!;
		expect(conn.circuitBreakerTripped).toBe(false);
	});
});
