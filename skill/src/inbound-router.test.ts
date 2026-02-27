import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MessageStore } from "./message-store.js";
import { ConnectionStore } from "./connection-store.js";
import { InboundRouter } from "./inbound-router.js";
import type { MessageRecord } from "./message-store.js";

/** Create a test message record in the store. */
function createTestMessage(
	store: MessageStore,
	overrides: Partial<MessageRecord> = {},
): MessageRecord {
	const now = new Date().toISOString();
	const msg: MessageRecord = {
		id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		connectionAddress: overrides.connectionAddress ?? "pinch:bob@localhost",
		direction: overrides.direction ?? "inbound",
		body: overrides.body ?? "Test message",
		threadId: overrides.threadId,
		replyTo: overrides.replyTo,
		priority: overrides.priority ?? "normal",
		sequence: overrides.sequence ?? 1,
		state: overrides.state ?? "delivered",
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
	store.saveMessage(msg);
	return msg;
}

describe("InboundRouter", () => {
	let tempDir: string;
	let messageStore: MessageStore;
	let connectionStore: ConnectionStore;
	let router: InboundRouter;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-router-test-"));
		messageStore = new MessageStore(join(tempDir, "messages.db"));
		connectionStore = new ConnectionStore(
			join(tempDir, "connections.json"),
		);
		await connectionStore.load();
		router = new InboundRouter(connectionStore, messageStore);
	});

	afterEach(() => {
		messageStore.close();
	});

	describe("route", () => {
		it("Full Manual connection routes message to escalated_to_human state", () => {
			connectionStore.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "Bob",
				autonomyLevel: "full_manual",
			});

			const msg = createTestMessage(messageStore, {
				connectionAddress: "pinch:bob@localhost",
			});

			const result = router.route(msg, "pinch:bob@localhost");

			expect(result.state).toBe("escalated_to_human");
			expect(result.messageId).toBe(msg.id);
			expect(result.senderAddress).toBe("pinch:bob@localhost");

			// Verify state was persisted
			const stored = messageStore.getMessage(msg.id);
			expect(stored!.state).toBe("escalated_to_human");
		});

		it("Full Auto connection routes message to read_by_agent state", () => {
			connectionStore.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "Bob",
				autonomyLevel: "full_auto",
			});

			const msg = createTestMessage(messageStore, {
				connectionAddress: "pinch:bob@localhost",
			});

			const result = router.route(msg, "pinch:bob@localhost");

			expect(result.state).toBe("read_by_agent");

			// Verify state was persisted
			const stored = messageStore.getMessage(msg.id);
			expect(stored!.state).toBe("read_by_agent");
		});

		it("Unknown sender gets failed state with failure reason", () => {
			const msg = createTestMessage(messageStore, {
				connectionAddress: "pinch:unknown@localhost",
			});

			const result = router.route(msg, "pinch:unknown@localhost");

			expect(result.state).toBe("failed");
			expect(result.failureReason).toBeDefined();
			expect(result.failureReason).toContain("unknown");

			// Verify state was persisted
			const stored = messageStore.getMessage(msg.id);
			expect(stored!.state).toBe("failed");
			expect(stored!.failureReason).toBeDefined();
		});
	});

	describe("getPendingForReview", () => {
		it("returns only escalated_to_human messages, ordered by created_at ASC", () => {
			connectionStore.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "Bob",
				autonomyLevel: "full_manual",
			});

			// Create messages with explicit timestamps for ordering
			const msg1 = createTestMessage(messageStore, {
				id: "msg-older",
				connectionAddress: "pinch:bob@localhost",
				state: "escalated_to_human",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			});
			const msg2 = createTestMessage(messageStore, {
				id: "msg-newer",
				connectionAddress: "pinch:bob@localhost",
				state: "escalated_to_human",
				createdAt: "2026-01-02T00:00:00Z",
				updatedAt: "2026-01-02T00:00:00Z",
			});
			// This one should NOT appear (different state)
			createTestMessage(messageStore, {
				id: "msg-delivered",
				connectionAddress: "pinch:bob@localhost",
				state: "delivered",
			});

			const pending = router.getPendingForReview();

			expect(pending).toHaveLength(2);
			// ASC order: older first
			expect(pending[0].id).toBe("msg-older");
			expect(pending[1].id).toBe("msg-newer");
		});
	});

	describe("approveMessage", () => {
		it("with 'agent_handle' transitions from escalated_to_human to read_by_agent", () => {
			const msg = createTestMessage(messageStore, {
				id: "approve-test-1",
				state: "escalated_to_human",
			});

			const result = router.approveMessage(
				"approve-test-1",
				"agent_handle",
			);

			expect(result).toBeDefined();
			expect(result!.state).toBe("read_by_agent");

			const stored = messageStore.getMessage("approve-test-1");
			expect(stored!.state).toBe("read_by_agent");
		});

		it("with 'human_respond' transitions from escalated_to_human to delivered", () => {
			const msg = createTestMessage(messageStore, {
				id: "approve-test-2",
				state: "escalated_to_human",
			});

			const result = router.approveMessage(
				"approve-test-2",
				"human_respond",
			);

			expect(result).toBeDefined();
			expect(result!.state).toBe("delivered");

			const stored = messageStore.getMessage("approve-test-2");
			expect(stored!.state).toBe("delivered");
		});

		it("returns undefined for non-escalated message", () => {
			const msg = createTestMessage(messageStore, {
				id: "approve-test-3",
				state: "delivered",
			});

			const result = router.approveMessage(
				"approve-test-3",
				"agent_handle",
			);

			expect(result).toBeUndefined();
		});

		it("returns undefined for non-existent message", () => {
			const result = router.approveMessage(
				"nonexistent",
				"agent_handle",
			);

			expect(result).toBeUndefined();
		});
	});
});
