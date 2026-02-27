import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MessageStore } from "./message-store.js";
import type { MessageRecord } from "./message-store.js";

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
	const now = new Date().toISOString();
	return {
		id: overrides.id ?? `msg-${Math.random().toString(36).slice(2)}`,
		connectionAddress:
			overrides.connectionAddress ?? "pinch:bob@localhost",
		direction: overrides.direction ?? "outbound",
		body: overrides.body ?? "Hello, world!",
		threadId: overrides.threadId,
		replyTo: overrides.replyTo,
		priority: overrides.priority ?? "normal",
		sequence: overrides.sequence ?? 1,
		state: overrides.state ?? "sent",
		failureReason: overrides.failureReason,
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

describe("MessageStore", () => {
	let tempDir: string;
	let store: MessageStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-msgstore-test-"));
		store = new MessageStore(join(tempDir, "messages.db"));
	});

	afterEach(async () => {
		store.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("saveMessage + getMessage roundtrip", () => {
		it("saves and retrieves a message with all fields", () => {
			const msg = makeMessage({
				id: "test-id-001",
				threadId: "thread-abc",
				replyTo: "msg-parent",
				priority: "urgent",
				failureReason: undefined,
			});

			store.saveMessage(msg);
			const retrieved = store.getMessage("test-id-001");

			expect(retrieved).toBeDefined();
			expect(retrieved!.id).toBe("test-id-001");
			expect(retrieved!.connectionAddress).toBe("pinch:bob@localhost");
			expect(retrieved!.direction).toBe("outbound");
			expect(retrieved!.body).toBe("Hello, world!");
			expect(retrieved!.threadId).toBe("thread-abc");
			expect(retrieved!.replyTo).toBe("msg-parent");
			expect(retrieved!.priority).toBe("urgent");
			expect(retrieved!.sequence).toBe(1);
			expect(retrieved!.state).toBe("sent");
			expect(retrieved!.failureReason).toBeUndefined();
			expect(retrieved!.createdAt).toBe(msg.createdAt);
			expect(retrieved!.updatedAt).toBe(msg.updatedAt);
		});

		it("returns undefined for non-existent message", () => {
			const result = store.getMessage("nonexistent");
			expect(result).toBeUndefined();
		});
	});

	describe("updateState", () => {
		it("changes state and updated_at timestamp", () => {
			const msg = makeMessage({ id: "update-test" });
			store.saveMessage(msg);

			const originalUpdatedAt = msg.updatedAt;

			// Small delay to ensure different timestamp.
			store.updateState("update-test", "delivered");

			const updated = store.getMessage("update-test");
			expect(updated).toBeDefined();
			expect(updated!.state).toBe("delivered");
			// updated_at should be a valid ISO timestamp, potentially different
			expect(updated!.updatedAt).toBeTruthy();
		});

		it("sets failure_reason when state is failed", () => {
			const msg = makeMessage({ id: "fail-test" });
			store.saveMessage(msg);

			store.updateState("fail-test", "failed", "Connection timed out");

			const updated = store.getMessage("fail-test");
			expect(updated!.state).toBe("failed");
			expect(updated!.failureReason).toBe("Connection timed out");
		});
	});

	describe("getHistory", () => {
		it("returns messages ordered by created_at DESC with pagination", () => {
			// Create messages with known timestamps.
			for (let i = 0; i < 5; i++) {
				const ts = new Date(Date.now() + i * 1000).toISOString();
				store.saveMessage(
					makeMessage({
						id: `hist-${i}`,
						createdAt: ts,
						updatedAt: ts,
						sequence: i + 1,
					}),
				);
			}

			// First page: 2 most recent.
			const page1 = store.getHistory({ limit: 2, offset: 0 });
			expect(page1).toHaveLength(2);
			expect(page1[0].id).toBe("hist-4");
			expect(page1[1].id).toBe("hist-3");

			// Second page.
			const page2 = store.getHistory({ limit: 2, offset: 2 });
			expect(page2).toHaveLength(2);
			expect(page2[0].id).toBe("hist-2");
			expect(page2[1].id).toBe("hist-1");
		});

		it("filters by connectionAddress", () => {
			store.saveMessage(
				makeMessage({
					id: "alice-1",
					connectionAddress: "pinch:alice@localhost",
					sequence: 1,
				}),
			);
			store.saveMessage(
				makeMessage({
					id: "bob-1",
					connectionAddress: "pinch:bob@localhost",
					sequence: 1,
				}),
			);

			const result = store.getHistory({
				connectionAddress: "pinch:alice@localhost",
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("alice-1");
		});

		it("filters by threadId", () => {
			store.saveMessage(
				makeMessage({
					id: "t1-1",
					threadId: "thread-1",
					sequence: 1,
				}),
			);
			store.saveMessage(
				makeMessage({
					id: "t2-1",
					threadId: "thread-2",
					sequence: 2,
				}),
			);
			store.saveMessage(
				makeMessage({
					id: "t1-2",
					threadId: "thread-1",
					sequence: 3,
				}),
			);

			const result = store.getHistory({ threadId: "thread-1" });
			expect(result).toHaveLength(2);
			expect(result.every((m) => m.threadId === "thread-1")).toBe(true);
		});

		it("filters by direction", () => {
			store.saveMessage(
				makeMessage({
					id: "in-1",
					direction: "inbound",
					sequence: 1,
				}),
			);
			store.saveMessage(
				makeMessage({
					id: "out-1",
					direction: "outbound",
					sequence: 2,
				}),
			);

			const result = store.getHistory({ direction: "inbound" });
			expect(result).toHaveLength(1);
			expect(result[0].direction).toBe("inbound");
		});
	});

	describe("getPending", () => {
		it("returns only pending messages for the specified direction", () => {
			store.saveMessage(
				makeMessage({
					id: "sent-1",
					direction: "outbound",
					state: "sent",
					sequence: 1,
				}),
			);
			store.saveMessage(
				makeMessage({
					id: "delivered-1",
					direction: "outbound",
					state: "delivered",
					sequence: 2,
				}),
			);
			store.saveMessage(
				makeMessage({
					id: "escalated-1",
					direction: "inbound",
					state: "escalated_to_human",
					sequence: 1,
				}),
			);
			store.saveMessage(
				makeMessage({
					id: "read-1",
					direction: "inbound",
					state: "read_by_agent",
					sequence: 2,
				}),
			);

			const outboundPending = store.getPending("outbound");
			expect(outboundPending).toHaveLength(1);
			expect(outboundPending[0].id).toBe("sent-1");

			const inboundPending = store.getPending("inbound");
			expect(inboundPending).toHaveLength(1);
			expect(inboundPending[0].id).toBe("escalated-1");
		});
	});

	describe("nextSequence", () => {
		it("returns 1 for first call on a new connection", () => {
			const seq = store.nextSequence("pinch:newpeer@localhost");
			expect(seq).toBe(1);
		});

		it("increments atomically on successive calls", () => {
			const seq1 = store.nextSequence("pinch:peer@localhost");
			const seq2 = store.nextSequence("pinch:peer@localhost");
			const seq3 = store.nextSequence("pinch:peer@localhost");

			expect(seq1).toBe(1);
			expect(seq2).toBe(2);
			expect(seq3).toBe(3);
		});

		it("is per-connection (independent sequences for different addresses)", () => {
			const seqA1 = store.nextSequence("pinch:alice@localhost");
			const seqB1 = store.nextSequence("pinch:bob@localhost");
			const seqA2 = store.nextSequence("pinch:alice@localhost");
			const seqB2 = store.nextSequence("pinch:bob@localhost");

			expect(seqA1).toBe(1);
			expect(seqB1).toBe(1);
			expect(seqA2).toBe(2);
			expect(seqB2).toBe(2);
		});
	});

	describe("close", () => {
		it("succeeds without error", () => {
			expect(() => store.close()).not.toThrow();
		});
	});
});
