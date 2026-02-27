import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	EncryptedPayloadSchema,
	PlaintextPayloadSchema,
	DeliveryConfirmSchema,
	MessageType,
} from "@pinch/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch/proto/pinch/v1/envelope_pb.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeypair } from "./identity.js";
import type { Keypair } from "./identity.js";
import { ensureSodiumReady, encrypt, ed25519PubToX25519, ed25519PrivToX25519 } from "./crypto.js";
import { signDeliveryConfirmation } from "./delivery.js";
import { MessageStore } from "./message-store.js";
import { ConnectionStore } from "./connection-store.js";
import { InboundRouter } from "./inbound-router.js";
import { MessageManager } from "./message-manager.js";
import type { RelayClient } from "./relay-client.js";

/** Create a mock RelayClient that tracks sent envelopes and supports multiple handlers. */
function createMockRelayClient(
	assignedAddress = "pinch:alice@localhost",
) {
	const mock = {
		assignedAddress,
		sentEnvelopes: [] as Uint8Array[],
		envelopeHandlers: [] as ((env: Envelope) => void)[],
		sendEnvelope(data: Uint8Array): void {
			mock.sentEnvelopes.push(data);
		},
		onEnvelope(handler: (env: Envelope) => void): void {
			mock.envelopeHandlers.push(handler);
		},
		connect: vi.fn(),
		disconnect: vi.fn(),
		isConnected: vi.fn(() => true),
		onMessage: vi.fn(),
		onDisconnect: vi.fn(),
		send: vi.fn(),
		waitForConnection: vi.fn(),
	};
	return mock as unknown as ReturnType<typeof createMockRelayClient> &
		typeof mock;
}

let aliceKeypair: Keypair;
let bobKeypair: Keypair;

beforeAll(async () => {
	await ensureSodiumReady();
	aliceKeypair = await generateKeypair();
	bobKeypair = await generateKeypair();
});

describe("MessageManager", () => {
	let tempDir: string;
	let messageStore: MessageStore;
	let connectionStore: ConnectionStore;
	let inboundRouter: InboundRouter;
	let mockRelay: ReturnType<typeof createMockRelayClient>;
	let manager: MessageManager;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-msgmgr-test-"));
		messageStore = new MessageStore(join(tempDir, "messages.db"));
		connectionStore = new ConnectionStore(
			join(tempDir, "connections.json"),
		);
		await connectionStore.load();

		// Add Bob as an active connection with his real public key.
		connectionStore.addConnection({
			peerAddress: "pinch:bob@localhost",
			peerPublicKey: Buffer.from(bobKeypair.publicKey).toString("base64"),
			state: "active",
			nickname: "Bob",
			autonomyLevel: "full_manual",
		});

		mockRelay = createMockRelayClient(
			"pinch:alice@localhost",
		) as any;
		inboundRouter = new InboundRouter(connectionStore, messageStore);
		manager = new MessageManager(
			mockRelay as unknown as RelayClient,
			connectionStore,
			messageStore,
			aliceKeypair,
			inboundRouter,
		);
		await manager.init();
	});

	afterEach(() => {
		messageStore.close();
	});

	describe("sendMessage", () => {
		it("encrypts and sends envelope via relayClient", async () => {
			const messageId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "Hello Bob!",
			});

			expect((mockRelay as any).sentEnvelopes).toHaveLength(1);
			const env = fromBinary(
				EnvelopeSchema,
				(mockRelay as any).sentEnvelopes[0],
			);
			expect(env.type).toBe(MessageType.MESSAGE);
			expect(env.fromAddress).toBe("pinch:alice@localhost");
			expect(env.toAddress).toBe("pinch:bob@localhost");
			expect(env.payload.case).toBe("encrypted");
		});

		it("returns a UUIDv7 messageId", async () => {
			const messageId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "Hello",
			});

			// UUIDv7 format: 8-4-4-4-12 hex chars
			expect(messageId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		});

		it("stores outbound message with state 'sent'", async () => {
			const messageId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "Test message",
			});

			const stored = messageStore.getMessage(messageId);
			expect(stored).toBeDefined();
			expect(stored!.direction).toBe("outbound");
			expect(stored!.state).toBe("sent");
			expect(stored!.body).toBe("Test message");
			expect(stored!.connectionAddress).toBe("pinch:bob@localhost");
		});

		it("throws if connection is not active", async () => {
			await expect(
				manager.sendMessage({
					recipient: "pinch:unknown@localhost",
					body: "Hello",
				}),
			).rejects.toThrow("Connection is not active");
		});

		it("throws if peer public key is not available", async () => {
			// Add connection with no public key
			connectionStore.addConnection({
				peerAddress: "pinch:charlie@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "Charlie",
				autonomyLevel: "full_manual",
			});

			// Since pinch:charlie@localhost is not a valid pinch address
			// (no real base58 payload), getPeerPublicKey returns null
			await expect(
				manager.sendMessage({
					recipient: "pinch:charlie@localhost",
					body: "Hello",
				}),
			).rejects.toThrow("Peer public key not available");
		});

		it("auto-generates threadId from messageId when not provided", async () => {
			const messageId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "Hello",
			});

			const stored = messageStore.getMessage(messageId);
			expect(stored!.threadId).toBe(messageId);
		});

		it("inherits threadId from replyTo message", async () => {
			// Send a first message that starts a thread
			const firstId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "First message",
				threadId: "custom-thread-123",
			});

			// Reply to it -- should inherit the threadId
			const replyId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "Reply message",
				replyTo: firstId,
			});

			const reply = messageStore.getMessage(replyId);
			expect(reply!.threadId).toBe("custom-thread-123");
		});

		it("rejects messages exceeding 60KB envelope size", async () => {
			// 60KB body will exceed 60KB once wrapped in protobuf
			const largeBody = "x".repeat(61 * 1024);

			await expect(
				manager.sendMessage({
					recipient: "pinch:bob@localhost",
					body: largeBody,
				}),
			).rejects.toThrow("message too large");
		});
	});

	describe("handleIncomingMessage", () => {
		it("decrypts and stores inbound message", async () => {
			// Bob sends an encrypted message to Alice
			const body = "Hello Alice from Bob!";
			const plaintextPayload = create(PlaintextPayloadSchema, {
				version: 1,
				sequence: 1n,
				timestamp: BigInt(Date.now()),
				content: new TextEncoder().encode(body),
				contentType: "text/plain",
			});
			const plaintextBytes = toBinary(
				PlaintextPayloadSchema,
				plaintextPayload,
			);

			// Encrypt using Bob's private key -> Alice's public key
			const bobX25519Priv = ed25519PrivToX25519(bobKeypair.privateKey);
			const aliceX25519Pub = ed25519PubToX25519(aliceKeypair.publicKey);
			const sealed = encrypt(
				plaintextBytes,
				aliceX25519Pub,
				bobX25519Priv,
			);
			const nonce = sealed.slice(0, 24);
			const ciphertext = sealed.slice(24);

			const messageId = "test-msg-id-001";
			const envelope = create(EnvelopeSchema, {
				version: 1,
				fromAddress: "pinch:bob@localhost",
				toAddress: "pinch:alice@localhost",
				type: MessageType.MESSAGE,
				messageId: new TextEncoder().encode(messageId),
				timestamp: BigInt(Date.now()),
				payload: {
					case: "encrypted",
					value: create(EncryptedPayloadSchema, {
						nonce,
						ciphertext,
						senderPublicKey: bobKeypair.publicKey,
					}),
				},
			});

			await manager.handleIncomingMessage(envelope);

			const stored = messageStore.getMessage(messageId);
			expect(stored).toBeDefined();
			expect(stored!.direction).toBe("inbound");
			expect(stored!.body).toBe(body);
			expect(stored!.connectionAddress).toBe("pinch:bob@localhost");
		});

		it("sends delivery confirmation back to sender", async () => {
			// Build encrypted message from Bob to Alice
			const plaintextPayload = create(PlaintextPayloadSchema, {
				version: 1,
				sequence: 1n,
				timestamp: BigInt(Date.now()),
				content: new TextEncoder().encode("Hello"),
				contentType: "text/plain",
			});
			const plaintextBytes = toBinary(
				PlaintextPayloadSchema,
				plaintextPayload,
			);
			const bobX25519Priv = ed25519PrivToX25519(bobKeypair.privateKey);
			const aliceX25519Pub = ed25519PubToX25519(aliceKeypair.publicKey);
			const sealed = encrypt(
				plaintextBytes,
				aliceX25519Pub,
				bobX25519Priv,
			);

			const envelope = create(EnvelopeSchema, {
				version: 1,
				fromAddress: "pinch:bob@localhost",
				toAddress: "pinch:alice@localhost",
				type: MessageType.MESSAGE,
				messageId: new TextEncoder().encode("confirm-test-001"),
				timestamp: BigInt(Date.now()),
				payload: {
					case: "encrypted",
					value: create(EncryptedPayloadSchema, {
						nonce: sealed.slice(0, 24),
						ciphertext: sealed.slice(24),
						senderPublicKey: bobKeypair.publicKey,
					}),
				},
			});

			await manager.handleIncomingMessage(envelope);

			// Check that a delivery confirmation was sent
			expect((mockRelay as any).sentEnvelopes).toHaveLength(1);
			const confirmEnv = fromBinary(
				EnvelopeSchema,
				(mockRelay as any).sentEnvelopes[0],
			);
			expect(confirmEnv.type).toBe(MessageType.DELIVERY_CONFIRM);
			expect(confirmEnv.toAddress).toBe("pinch:bob@localhost");
			expect(confirmEnv.payload.case).toBe("deliveryConfirm");
			if (confirmEnv.payload.case === "deliveryConfirm") {
				expect(confirmEnv.payload.value.state).toBe("delivered");
				expect(confirmEnv.payload.value.signature.length).toBe(64);
			}
		});
	});

	describe("handleDeliveryConfirmation", () => {
		it("verifies signature and updates message state", async () => {
			// First, send a message from Alice so there's a stored outbound message
			const messageId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "Hello Bob",
			});

			// Simulate Bob sending back a signed delivery confirmation
			const messageIdBytes = new TextEncoder().encode(messageId);
			const timestamp = BigInt(Date.now());
			const signature = await signDeliveryConfirmation(
				messageIdBytes,
				timestamp,
				bobKeypair.privateKey,
			);

			const confirmEnvelope = create(EnvelopeSchema, {
				version: 1,
				fromAddress: "pinch:bob@localhost",
				toAddress: "pinch:alice@localhost",
				type: MessageType.DELIVERY_CONFIRM,
				timestamp,
				payload: {
					case: "deliveryConfirm",
					value: create(DeliveryConfirmSchema, {
						messageId: messageIdBytes,
						signature,
						timestamp,
						state: "delivered",
					}),
				},
			});

			await manager.handleDeliveryConfirmation(confirmEnvelope);

			const stored = messageStore.getMessage(messageId);
			expect(stored!.state).toBe("delivered");
		});

		it("rejects forged confirmation (wrong key)", async () => {
			// Send a message from Alice
			const messageId = await manager.sendMessage({
				recipient: "pinch:bob@localhost",
				body: "Hello Bob",
			});

			// Forge a confirmation using a different keypair (not Bob's)
			const fakeKeypair = await generateKeypair();
			const messageIdBytes = new TextEncoder().encode(messageId);
			const timestamp = BigInt(Date.now());
			const fakeSignature = await signDeliveryConfirmation(
				messageIdBytes,
				timestamp,
				fakeKeypair.privateKey,
			);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const confirmEnvelope = create(EnvelopeSchema, {
				version: 1,
				fromAddress: "pinch:bob@localhost",
				toAddress: "pinch:alice@localhost",
				type: MessageType.DELIVERY_CONFIRM,
				timestamp,
				payload: {
					case: "deliveryConfirm",
					value: create(DeliveryConfirmSchema, {
						messageId: messageIdBytes,
						signature: fakeSignature,
						timestamp,
						state: "delivered",
					}),
				},
			});

			await manager.handleDeliveryConfirmation(confirmEnvelope);

			// State should NOT be updated -- still "sent"
			const stored = messageStore.getMessage(messageId);
			expect(stored!.state).toBe("sent");

			// Warning should have been logged
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Invalid delivery confirmation"),
			);
			warnSpy.mockRestore();
		});
	});

	describe("Multiple onEnvelope handlers", () => {
		it("multiple handlers all receive the same envelope", () => {
			const received1: Envelope[] = [];
			const received2: Envelope[] = [];

			(mockRelay as any).envelopeHandlers = [];
			(mockRelay as any).onEnvelope((env: Envelope) => {
				received1.push(env);
			});
			(mockRelay as any).onEnvelope((env: Envelope) => {
				received2.push(env);
			});

			const testEnv = create(EnvelopeSchema, {
				version: 1,
				type: MessageType.HEARTBEAT,
			});

			// Simulate dispatch to all handlers
			for (const handler of (mockRelay as any).envelopeHandlers) {
				handler(testEnv);
			}

			expect(received1).toHaveLength(1);
			expect(received2).toHaveLength(1);
			expect(received1[0]).toBe(received2[0]);
		});
	});
});
