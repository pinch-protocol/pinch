import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { ActivityFeed } from "./activity-feed.js";

describe("ActivityFeed", () => {
	let tempDir: string;
	let db: DatabaseType;
	let feed: ActivityFeed;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-activity-feed-"));
		db = new Database(join(tempDir, "test.db"));
		db.pragma("journal_mode = WAL");
		feed = new ActivityFeed(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("table creation", () => {
		it("creates activity_events table on construction", () => {
			const tables = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='activity_events'",
				)
				.all() as { name: string }[];
			expect(tables).toHaveLength(1);
			expect(tables[0].name).toBe("activity_events");
		});
	});

	describe("record", () => {
		it("records an event and returns it with generated id and timestamp", () => {
			const event = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_processed_autonomously",
				messageId: "msg-123",
				badge: "processed_autonomously",
			});

			expect(event.id).toBeTruthy();
			expect(event.connectionAddress).toBe("pinch:bob@localhost");
			expect(event.eventType).toBe("message_processed_autonomously");
			expect(event.messageId).toBe("msg-123");
			expect(event.badge).toBe("processed_autonomously");
			expect(event.createdAt).toBeTruthy();
			expect(() => new Date(event.createdAt)).not.toThrow();
		});
	});

	describe("getEvents", () => {
		it("retrieves events by connectionAddress", () => {
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_processed_autonomously",
			});
			feed.record({
				connectionAddress: "pinch:alice@localhost",
				eventType: "message_processed_autonomously",
			});
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "circuit_breaker_tripped",
			});

			const bobEvents = feed.getEvents({
				connectionAddress: "pinch:bob@localhost",
			});
			expect(bobEvents).toHaveLength(2);
			for (const e of bobEvents) {
				expect(e.connectionAddress).toBe("pinch:bob@localhost");
			}
		});

		it("retrieves events by eventType", () => {
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_processed_autonomously",
			});
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "circuit_breaker_tripped",
			});
			feed.record({
				connectionAddress: "pinch:alice@localhost",
				eventType: "message_processed_autonomously",
			});

			const processed = feed.getEvents({
				eventType: "message_processed_autonomously",
			});
			expect(processed).toHaveLength(2);
			for (const e of processed) {
				expect(e.eventType).toBe("message_processed_autonomously");
			}
		});

		it("respects limit parameter", () => {
			for (let i = 0; i < 10; i++) {
				feed.record({
					connectionAddress: "pinch:bob@localhost",
					eventType: "message_processed_autonomously",
					messageId: `msg-${i}`,
				});
			}

			const limited = feed.getEvents({ limit: 3 });
			expect(limited).toHaveLength(3);
		});

		it("returns events in DESC order by createdAt", async () => {
			const event1 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_processed_autonomously",
				messageId: "msg-first",
			});

			// Small delay to ensure different timestamp
			await new Promise((r) => setTimeout(r, 10));

			const event2 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_processed_autonomously",
				messageId: "msg-second",
			});

			const events = feed.getEvents();
			// Most recent (event2) should come first
			expect(events[0].id).toBe(event2.id);
			expect(events[1].id).toBe(event1.id);
		});
	});

	describe("UUIDv7 ordering", () => {
		it("later events have higher IDs (UUIDv7 is time-ordered)", () => {
			const event1 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_processed_autonomously",
			});
			const event2 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_processed_autonomously",
			});

			// UUIDv7 is time-ordered, so lexicographic comparison works
			expect(event2.id > event1.id).toBe(true);
		});
	});
});
