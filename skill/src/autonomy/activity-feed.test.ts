import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { ActivityFeed, computeEntryHash } from "./activity-feed.js";

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

		it("includes OVRS-06 columns in schema", () => {
			const columns = db
				.prepare("PRAGMA table_info(activity_events)")
				.all() as { name: string }[];
			const names = columns.map((c) => c.name);
			expect(names).toContain("actor_pubkey");
			expect(names).toContain("action_type");
			expect(names).toContain("message_hash");
			expect(names).toContain("prev_hash");
			expect(names).toContain("entry_hash");
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

		it("creates entries with non-empty entryHash and prevHash fields", () => {
			const event1 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_send",
			});

			// First entry: prevHash is empty (genesis), entryHash is computed.
			expect(event1.entryHash).toBeTruthy();
			expect(event1.entryHash!.length).toBe(64); // SHA-256 hex
			expect(event1.prevHash).toBe("");

			const event2 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_receive",
			});

			// Second entry: prevHash links to first entry's entryHash.
			expect(event2.entryHash).toBeTruthy();
			expect(event2.entryHash!.length).toBe(64);
			expect(event2.prevHash).toBe(event1.entryHash);
		});

		it("records events with OVRS-06 fields (actorPubkey, actionType, messageHash)", () => {
			const event = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_send",
				actorPubkey: "abc123pubkey",
				actionType: "message_send",
				messageHash: "sha256hashofmessage",
			});

			expect(event.actorPubkey).toBe("abc123pubkey");
			expect(event.actionType).toBe("message_send");
			expect(event.messageHash).toBe("sha256hashofmessage");

			// Verify stored in DB
			const row = db
				.prepare("SELECT * FROM activity_events WHERE id = ?")
				.get(event.id) as Record<string, unknown>;
			expect(row.actor_pubkey).toBe("abc123pubkey");
			expect(row.action_type).toBe("message_send");
			expect(row.message_hash).toBe("sha256hashofmessage");
		});

		it("backward compatible: record() without new fields still works", () => {
			const event = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "circuit_breaker_tripped",
				badge: "warning",
				details: "too many failures",
			});

			expect(event.id).toBeTruthy();
			expect(event.entryHash).toBeTruthy();
			expect(event.prevHash).toBe("");
			expect(event.actorPubkey).toBeUndefined();
			expect(event.actionType).toBeUndefined();
			expect(event.messageHash).toBeUndefined();

			// Verify the hash was computed with defaults
			const row = db
				.prepare("SELECT * FROM activity_events WHERE id = ?")
				.get(event.id) as Record<string, unknown>;
			expect(row.entry_hash).toBe(event.entryHash);
			expect(row.prev_hash).toBe("");
			// actionType defaults to eventType when not provided
			expect(row.action_type).toBe("circuit_breaker_tripped");
		});
	});

	describe("hash chain integrity", () => {
		it("verifies hash chain across 3 events", () => {
			const event1 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_send",
				actorPubkey: "pubkey1",
			});

			const event2 = feed.record({
				connectionAddress: "pinch:alice@localhost",
				eventType: "connection_approve",
				actorPubkey: "pubkey2",
			});

			const event3 = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "autonomy_change",
				actorPubkey: "pubkey1",
			});

			// Chain: event1.prevHash="" -> event2.prevHash=event1.entryHash -> event3.prevHash=event2.entryHash
			expect(event1.prevHash).toBe("");
			expect(event2.prevHash).toBe(event1.entryHash);
			expect(event3.prevHash).toBe(event2.entryHash);

			// Verify each entryHash is correctly computed
			const recomputed1 = computeEntryHash({
				id: event1.id,
				timestamp: event1.createdAt,
				actorPubkey: event1.actorPubkey ?? "",
				actionType: event1.actionType ?? event1.eventType,
				connectionAddress: event1.connectionAddress,
				messageHash: event1.messageHash ?? "",
				prevHash: event1.prevHash!,
			});
			expect(recomputed1).toBe(event1.entryHash);

			const recomputed2 = computeEntryHash({
				id: event2.id,
				timestamp: event2.createdAt,
				actorPubkey: event2.actorPubkey ?? "",
				actionType: event2.actionType ?? event2.eventType,
				connectionAddress: event2.connectionAddress,
				messageHash: event2.messageHash ?? "",
				prevHash: event2.prevHash!,
			});
			expect(recomputed2).toBe(event2.entryHash);

			const recomputed3 = computeEntryHash({
				id: event3.id,
				timestamp: event3.createdAt,
				actorPubkey: event3.actorPubkey ?? "",
				actionType: event3.actionType ?? event3.eventType,
				connectionAddress: event3.connectionAddress,
				messageHash: event3.messageHash ?? "",
				prevHash: event3.prevHash!,
			});
			expect(recomputed3).toBe(event3.entryHash);
		});
	});

	describe("computeEntryHash", () => {
		it("produces consistent deterministic output", () => {
			const input = {
				id: "test-id-123",
				timestamp: "2026-02-27T00:00:00.000Z",
				actorPubkey: "pubkey-abc",
				actionType: "message_send",
				connectionAddress: "pinch:bob@localhost",
				messageHash: "msg-hash-xyz",
				prevHash: "prev-hash-000",
			};

			const hash1 = computeEntryHash(input);
			const hash2 = computeEntryHash(input);
			const hash3 = computeEntryHash(input);

			expect(hash1).toBe(hash2);
			expect(hash2).toBe(hash3);
			expect(hash1.length).toBe(64); // SHA-256 hex = 64 chars
		});

		it("produces different output for different inputs", () => {
			const base = {
				id: "test-id-123",
				timestamp: "2026-02-27T00:00:00.000Z",
				actorPubkey: "pubkey-abc",
				actionType: "message_send",
				connectionAddress: "pinch:bob@localhost",
				messageHash: "msg-hash-xyz",
				prevHash: "prev-hash-000",
			};

			const hash1 = computeEntryHash(base);
			const hash2 = computeEntryHash({ ...base, id: "different-id" });
			const hash3 = computeEntryHash({ ...base, prevHash: "different-prev" });

			expect(hash1).not.toBe(hash2);
			expect(hash1).not.toBe(hash3);
			expect(hash2).not.toBe(hash3);
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

		it("filters by time range (since/until)", async () => {
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "early_event",
			});
			const earlyTime = new Date().toISOString();

			await new Promise((r) => setTimeout(r, 15));

			const midEvent = feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "mid_event",
			});
			const midTime = midEvent.createdAt;

			await new Promise((r) => setTimeout(r, 15));

			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "late_event",
			});

			// since: only events after earlyTime
			const afterEarly = feed.getEvents({ since: earlyTime });
			expect(afterEarly.length).toBeGreaterThanOrEqual(2);

			// until: only events before or at midTime
			const beforeMid = feed.getEvents({ until: midTime });
			expect(beforeMid.length).toBeGreaterThanOrEqual(2);

			// Tight range: only the mid event
			const tight = feed.getEvents({ since: midTime, until: midTime });
			expect(tight).toHaveLength(1);
			expect(tight[0].eventType).toBe("mid_event");
		});

		it("excludes event types via excludeEventTypes", () => {
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_send",
			});
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_received_muted",
			});
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_receive_muted",
			});
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "connection_approve",
			});

			const events = feed.getEvents({
				excludeEventTypes: [
					"message_received_muted",
					"message_receive_muted",
				],
			});
			expect(events).toHaveLength(2);
			for (const e of events) {
				expect(e.eventType).not.toBe("message_received_muted");
				expect(e.eventType).not.toBe("message_receive_muted");
			}
		});

		it("returns OVRS-06 fields in query results", () => {
			feed.record({
				connectionAddress: "pinch:bob@localhost",
				eventType: "message_send",
				actorPubkey: "pubkey-abc",
				actionType: "message_send",
				messageHash: "hash-xyz",
			});

			const events = feed.getEvents();
			expect(events).toHaveLength(1);
			expect(events[0].actorPubkey).toBe("pubkey-abc");
			expect(events[0].actionType).toBe("message_send");
			expect(events[0].messageHash).toBe("hash-xyz");
			expect(events[0].entryHash).toBeTruthy();
			expect(events[0].prevHash).toBe("");
		});
	});

	describe("schema evolution", () => {
		it("adds new columns to an existing table without losing data", () => {
			// Simulate Phase 5 table (no OVRS-06 columns).
			const db2 = new Database(join(tempDir, "evolution.db"));
			db2.pragma("journal_mode = WAL");
			db2.exec(`
				CREATE TABLE activity_events (
					id TEXT PRIMARY KEY,
					connection_address TEXT NOT NULL,
					event_type TEXT NOT NULL,
					message_id TEXT,
					badge TEXT,
					details TEXT,
					created_at TEXT NOT NULL
				);
			`);
			db2.prepare(`
				INSERT INTO activity_events (id, connection_address, event_type, created_at)
				VALUES ('old-1', 'pinch:bob@localhost', 'old_event', '2026-01-01T00:00:00.000Z')
			`).run();

			// Constructing ActivityFeed should evolve the schema.
			const feed2 = new ActivityFeed(db2);

			// Old data still accessible.
			const events = feed2.getEvents();
			expect(events).toHaveLength(1);
			expect(events[0].id).toBe("old-1");

			// New records work with hash chaining.
			const newEvent = feed2.record({
				connectionAddress: "pinch:alice@localhost",
				eventType: "new_event",
			});
			expect(newEvent.entryHash).toBeTruthy();
			// prevHash is "" because the old entry has entry_hash='' (default).
			expect(newEvent.prevHash).toBe("");

			db2.close();
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
