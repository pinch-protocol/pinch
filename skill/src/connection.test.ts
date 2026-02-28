import { describe, it, expect, beforeEach, vi } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	MessageType,
} from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import { create } from "@bufbuild/protobuf";
import {
	ConnectionRequestSchema,
	ConnectionResponseSchema,
	ConnectionRevokeSchema,
} from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import { ConnectionManager } from "./connection.js";
import { ConnectionStore } from "./connection-store.js";
import type { RelayClient } from "./relay-client.js";
import type { Keypair } from "./identity.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Generate a deterministic test keypair (not cryptographically valid but structurally correct). */
function makeTestKeypair(seed: number = 1): Keypair {
	return {
		publicKey: new Uint8Array(32).fill(seed),
		privateKey: new Uint8Array(64).fill(seed),
	};
}

/** Create a mock RelayClient with the methods ConnectionManager uses. */
function createMockRelayClient(
	assignedAddress = "pinch:alice@localhost",
): RelayClient & { sentEnvelopes: Uint8Array[]; envelopeCallback: ((env: Envelope) => void) | null } {
	const mock = {
		assignedAddress,
		sentEnvelopes: [] as Uint8Array[],
		envelopeCallback: null as ((env: Envelope) => void) | null,
		sendEnvelope(data: Uint8Array): void {
			mock.sentEnvelopes.push(data);
		},
		onEnvelope(handler: (env: Envelope) => void): void {
			mock.envelopeCallback = handler;
		},
		// Other methods not needed by ConnectionManager
		connect: vi.fn(),
		disconnect: vi.fn(),
		isConnected: vi.fn(() => true),
		onMessage: vi.fn(),
		send: vi.fn(),
		waitForConnection: vi.fn(),
	};
	return mock as unknown as RelayClient & {
		sentEnvelopes: Uint8Array[];
		envelopeCallback: ((env: Envelope) => void) | null;
	};
}

/** Decode a sent envelope for assertion. */
function decodeSentEnvelope(data: Uint8Array): Envelope {
	return fromBinary(EnvelopeSchema, data);
}

/** Create a mock incoming envelope. */
function createIncomingEnvelope(
	type: MessageType,
	payloadCase: string,
	payloadValue: unknown,
): Envelope {
	const env = create(EnvelopeSchema, {
		version: 1,
		type,
		payload: {
			case: payloadCase as "connectionRequest",
			value: payloadValue as any,
		},
	});
	return env;
}

describe("ConnectionManager", () => {
	let tempDir: string;
	let store: ConnectionStore;
	let mockRelay: ReturnType<typeof createMockRelayClient>;
	let manager: ConnectionManager;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-conn-test-"));
		store = new ConnectionStore(join(tempDir, "connections.json"));
		await store.load();
		mockRelay = createMockRelayClient("pinch:alice@localhost");
		manager = new ConnectionManager(
			mockRelay as unknown as RelayClient,
			store,
			makeTestKeypair(10),
		);
	});

	// Cleanup handled by OS temp dir.

	describe("sendRequest", () => {
		it("creates pending_outbound connection and sends ConnectionRequest envelope", async () => {
			await manager.sendRequest(
				"pinch:bob@localhost",
				"Hello from Alice",
			);

			// Verify envelope was sent.
			expect(mockRelay.sentEnvelopes).toHaveLength(1);
			const env = decodeSentEnvelope(mockRelay.sentEnvelopes[0]);
			expect(env.type).toBe(MessageType.CONNECTION_REQUEST);
			expect(env.fromAddress).toBe("pinch:alice@localhost");
			expect(env.toAddress).toBe("pinch:bob@localhost");
			expect(env.payload.case).toBe("connectionRequest");
			if (env.payload.case === "connectionRequest") {
				expect(env.payload.value.message).toBe("Hello from Alice");
				expect(env.payload.value.fromAddress).toBe(
					"pinch:alice@localhost",
				);
				expect(env.payload.value.toAddress).toBe(
					"pinch:bob@localhost",
				);
				expect(Number(env.payload.value.expiresAt)).toBeGreaterThan(0);
			}

			// Verify local store has pending_outbound.
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn).toBeDefined();
			expect(conn!.state).toBe("pending_outbound");
			expect(conn!.shortMessage).toBe("Hello from Alice");
			expect(conn!.expiresAt).toBeDefined();
		});

		it("rejects message > 280 chars", async () => {
			const longMessage = "x".repeat(281);
			await expect(
				manager.sendRequest("pinch:bob@localhost", longMessage),
			).rejects.toThrow("280 character limit");
		});

		it("accepts message of exactly 280 chars", async () => {
			const exactMessage = "x".repeat(280);
			await expect(
				manager.sendRequest("pinch:bob@localhost", exactMessage),
			).resolves.toBeUndefined();
		});
	});

	describe("handleIncomingRequest", () => {
		it("creates pending_inbound connection with sender info", async () => {
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hello from Bob",
					senderPublicKey: new Uint8Array(32).fill(1),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			await manager.handleIncomingRequest(envelope);

			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn).toBeDefined();
			expect(conn!.state).toBe("pending_inbound");
			expect(conn!.shortMessage).toBe("Hello from Bob");
			expect(conn!.peerPublicKey).toBeTruthy();
			expect(conn!.autonomyLevel).toBe("full_manual");
		});
	});

	describe("approveRequest", () => {
		it("sends ConnectionResponse with own pubkey and marks connection active", async () => {
			// Set up a pending_inbound connection.
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: Buffer.from(new Uint8Array(32).fill(1)).toString(
					"base64",
				),
				state: "pending_inbound",
				nickname: "",
				autonomyLevel: "full_manual",
				shortMessage: "Hello",
			});

			await manager.approveRequest("pinch:bob@localhost");

			// Verify ConnectionResponse was sent.
			expect(mockRelay.sentEnvelopes).toHaveLength(1);
			const env = decodeSentEnvelope(mockRelay.sentEnvelopes[0]);
			expect(env.type).toBe(MessageType.CONNECTION_RESPONSE);
			expect(env.payload.case).toBe("connectionResponse");
			if (env.payload.case === "connectionResponse") {
				expect(env.payload.value.accepted).toBe(true);
				expect(env.payload.value.fromAddress).toBe(
					"pinch:alice@localhost",
				);
				expect(env.payload.value.toAddress).toBe(
					"pinch:bob@localhost",
				);
			}

			// Verify connection is now active.
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("active");
		});

		it("throws if connection is not pending_inbound", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "",
				autonomyLevel: "full_manual",
			});

			await expect(
				manager.approveRequest("pinch:bob@localhost"),
			).rejects.toThrow("Cannot approve");
		});
	});

	describe("rejectRequest", () => {
		it("does NOT send any response (silent rejection) and marks as revoked", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "pending_inbound",
				nickname: "",
				autonomyLevel: "full_manual",
				shortMessage: "Hello",
			});

			await manager.rejectRequest("pinch:bob@localhost");

			// CRITICAL: No envelope sent -- silent rejection.
			expect(mockRelay.sentEnvelopes).toHaveLength(0);

			// Connection marked as revoked locally.
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("revoked");
		});

		it("throws if connection is not pending_inbound", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "",
				autonomyLevel: "full_manual",
			});

			await expect(
				manager.rejectRequest("pinch:bob@localhost"),
			).rejects.toThrow("Cannot reject");
		});
	});

	describe("handleIncomingResponse", () => {
		it("marks connection active and stores responder pubkey on acceptance", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "pending_outbound",
				nickname: "",
				autonomyLevel: "full_manual",
				shortMessage: "Hello",
			});

			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_RESPONSE,
				"connectionResponse",
				create(ConnectionResponseSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					accepted: true,
					responderPublicKey: new Uint8Array(32).fill(2),
				}),
			);

			await manager.handleIncomingResponse(envelope);

			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("active");
			expect(conn!.peerPublicKey).toBeTruthy();
		});

		it("handles non-accepted response gracefully by marking as revoked", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "pending_outbound",
				nickname: "",
				autonomyLevel: "full_manual",
			});

			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_RESPONSE,
				"connectionResponse",
				create(ConnectionResponseSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					accepted: false,
					responderPublicKey: new Uint8Array(0),
				}),
			);

			await manager.handleIncomingResponse(envelope);

			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("revoked");
		});
	});

	describe("blockConnection", () => {
		it("sends BlockNotification and marks connection blocked", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "",
				autonomyLevel: "full_manual",
			});

			await manager.blockConnection("pinch:bob@localhost");

			// Verify BlockNotification was sent to relay.
			expect(mockRelay.sentEnvelopes).toHaveLength(1);
			const env = decodeSentEnvelope(mockRelay.sentEnvelopes[0]);
			expect(env.type).toBe(MessageType.BLOCK_NOTIFICATION);
			expect(env.payload.case).toBe("blockNotification");
			if (env.payload.case === "blockNotification") {
				expect(env.payload.value.blockerAddress).toBe(
					"pinch:alice@localhost",
				);
				expect(env.payload.value.blockedAddress).toBe(
					"pinch:bob@localhost",
				);
			}

			// Connection marked as blocked locally.
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("blocked");
		});
	});

	describe("unblockConnection", () => {
		it("sends UnblockNotification and marks connection active", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "blocked",
				nickname: "",
				autonomyLevel: "full_manual",
			});

			await manager.unblockConnection("pinch:bob@localhost");

			// Verify UnblockNotification was sent to relay.
			expect(mockRelay.sentEnvelopes).toHaveLength(1);
			const env = decodeSentEnvelope(mockRelay.sentEnvelopes[0]);
			expect(env.type).toBe(MessageType.UNBLOCK_NOTIFICATION);
			expect(env.payload.case).toBe("unblockNotification");
			if (env.payload.case === "unblockNotification") {
				expect(env.payload.value.unblockerAddress).toBe(
					"pinch:alice@localhost",
				);
				expect(env.payload.value.unblockedAddress).toBe(
					"pinch:bob@localhost",
				);
			}

			// Connection restored to active.
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("active");
		});
	});

	describe("revokeConnection", () => {
		it("sends ConnectionRevoke and marks connection revoked", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "",
				autonomyLevel: "full_manual",
			});

			await manager.revokeConnection("pinch:bob@localhost");

			// Verify ConnectionRevoke was sent.
			expect(mockRelay.sentEnvelopes).toHaveLength(1);
			const env = decodeSentEnvelope(mockRelay.sentEnvelopes[0]);
			expect(env.type).toBe(MessageType.CONNECTION_REVOKE);
			expect(env.payload.case).toBe("connectionRevoke");
			if (env.payload.case === "connectionRevoke") {
				expect(env.payload.value.fromAddress).toBe(
					"pinch:alice@localhost",
				);
				expect(env.payload.value.toAddress).toBe(
					"pinch:bob@localhost",
				);
			}

			// Connection marked as revoked.
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("revoked");
		});
	});

	describe("handleIncomingRevoke", () => {
		it("marks connection revoked when receiving a revoke notification", async () => {
			store.addConnection({
				peerAddress: "pinch:bob@localhost",
				peerPublicKey: "",
				state: "active",
				nickname: "",
				autonomyLevel: "full_manual",
			});

			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REVOKE,
				"connectionRevoke",
				create(ConnectionRevokeSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
				}),
			);

			await manager.handleIncomingRevoke(envelope);

			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.state).toBe("revoked");
		});

		it("handles revoke from unknown peer gracefully", async () => {
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REVOKE,
				"connectionRevoke",
				create(ConnectionRevokeSchema, {
					fromAddress: "pinch:unknown@localhost",
					toAddress: "pinch:alice@localhost",
				}),
			);

			// Should not throw -- unknown peer just ignored.
			await expect(
				manager.handleIncomingRevoke(envelope),
			).resolves.toBeUndefined();
		});
	});

	describe("Full flow: request -> approve -> active on both sides", () => {
		it("completes the full connection lifecycle", async () => {
			// Set up Alice's side (requester).
			const aliceTempDir = await mkdtemp(
				join(tmpdir(), "pinch-alice-"),
			);
			const aliceStore = new ConnectionStore(
				join(aliceTempDir, "connections.json"),
			);
			await aliceStore.load();
			const aliceRelay = createMockRelayClient("pinch:alice@localhost");
			const aliceManager = new ConnectionManager(
				aliceRelay as unknown as RelayClient,
				aliceStore,
				makeTestKeypair(10),
			);

			// Set up Bob's side (approver).
			const bobTempDir = await mkdtemp(join(tmpdir(), "pinch-bob-"));
			const bobStore = new ConnectionStore(
				join(bobTempDir, "connections.json"),
			);
			await bobStore.load();
			const bobRelay = createMockRelayClient("pinch:bob@localhost");
			const bobManager = new ConnectionManager(
				bobRelay as unknown as RelayClient,
				bobStore,
				makeTestKeypair(20),
			);

			// Step 1: Alice sends connection request.
			await aliceManager.sendRequest(
				"pinch:bob@localhost",
				"Hello from Alice",
			);
			expect(aliceStore.getConnection("pinch:bob@localhost")!.state).toBe(
				"pending_outbound",
			);

			// Step 2: Bob receives the request (simulated by deserializing Alice's sent envelope).
			const requestData = aliceRelay.sentEnvelopes[0];
			const requestEnv = fromBinary(EnvelopeSchema, requestData);
			await bobManager.handleIncomingRequest(requestEnv);
			expect(
				bobStore.getConnection("pinch:alice@localhost")!.state,
			).toBe("pending_inbound");

			// Step 3: Bob approves.
			await bobManager.approveRequest("pinch:alice@localhost");
			expect(
				bobStore.getConnection("pinch:alice@localhost")!.state,
			).toBe("active");

			// Step 4: Alice receives the response.
			const responseData = bobRelay.sentEnvelopes[0];
			const responseEnv = fromBinary(EnvelopeSchema, responseData);
			await aliceManager.handleIncomingResponse(responseEnv);
			expect(
				aliceStore.getConnection("pinch:bob@localhost")!.state,
			).toBe("active");
		});
	});

	describe("Full flow: request -> reject -> no feedback to sender", () => {
		it("silently rejects without any feedback to sender", async () => {
			// Set up Alice and Bob.
			const aliceTempDir = await mkdtemp(
				join(tmpdir(), "pinch-alice-"),
			);
			const aliceStore = new ConnectionStore(
				join(aliceTempDir, "connections.json"),
			);
			await aliceStore.load();
			const aliceRelay = createMockRelayClient("pinch:alice@localhost");
			const aliceManager = new ConnectionManager(
				aliceRelay as unknown as RelayClient,
				aliceStore,
				makeTestKeypair(10),
			);

			const bobTempDir = await mkdtemp(join(tmpdir(), "pinch-bob-"));
			const bobStore = new ConnectionStore(
				join(bobTempDir, "connections.json"),
			);
			await bobStore.load();
			const bobRelay = createMockRelayClient("pinch:bob@localhost");
			const bobManager = new ConnectionManager(
				bobRelay as unknown as RelayClient,
				bobStore,
				makeTestKeypair(20),
			);

			// Alice sends request.
			await aliceManager.sendRequest(
				"pinch:bob@localhost",
				"Please connect",
			);

			// Bob receives and rejects.
			const requestData = aliceRelay.sentEnvelopes[0];
			const requestEnv = fromBinary(EnvelopeSchema, requestData);
			await bobManager.handleIncomingRequest(requestEnv);
			await bobManager.rejectRequest("pinch:alice@localhost");

			// CRITICAL: Bob sent ZERO envelopes -- silent rejection.
			expect(bobRelay.sentEnvelopes).toHaveLength(0);

			// Bob's store shows revoked.
			expect(
				bobStore.getConnection("pinch:alice@localhost")!.state,
			).toBe("revoked");

			// Alice's store still shows pending_outbound -- no feedback at all.
			expect(
				aliceStore.getConnection("pinch:bob@localhost")!.state,
			).toBe("pending_outbound");
		});
	});

	describe("Autonomy: new connections default to full_manual", () => {
		it("all new connections from approveRequest default to full_manual", async () => {
			// Incoming request creates full_manual.
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hi",
					senderPublicKey: new Uint8Array(32).fill(1),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			await manager.handleIncomingRequest(envelope);
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.autonomyLevel).toBe("full_manual");

			// After approval, still full_manual.
			await manager.approveRequest("pinch:bob@localhost");
			const active = store.getConnection("pinch:bob@localhost");
			expect(active!.autonomyLevel).toBe("full_manual");
		});

		it("sendRequest creates connection with full_manual", async () => {
			await manager.sendRequest(
				"pinch:bob@localhost",
				"Hello",
			);
			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn!.autonomyLevel).toBe("full_manual");
		});
	});

	describe("onConnectionRequest callback", () => {
		it("fires with correct fromAddress and message", async () => {
			const callback = vi.fn();
			const callbackManager = new ConnectionManager(
				mockRelay as unknown as RelayClient,
				store,
				makeTestKeypair(10),
				callback,
			);
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hello from Bob",
					senderPublicKey: new Uint8Array(32).fill(1),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			await callbackManager.handleIncomingRequest(envelope);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				"pinch:bob@localhost",
				"Hello from Bob",
			);
		});

		it("fires AFTER store is saved", async () => {
			const events: string[] = [];
			const saveSpy = vi
				.spyOn(store, "save")
				.mockImplementation(async () => {
					events.push("save");
				});

			const callbackManager = new ConnectionManager(
				mockRelay as unknown as RelayClient,
				store,
				makeTestKeypair(10),
				() => {
					events.push("callback");
				},
			);
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hello from Bob",
					senderPublicKey: new Uint8Array(32).fill(1),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			await callbackManager.handleIncomingRequest(envelope);

			expect(saveSpy).toHaveBeenCalledTimes(1);
			expect(events).toEqual(["save", "callback"]);
		});

		it("does not throw when callback is not set", async () => {
			const noCallbackManager = new ConnectionManager(
				mockRelay as unknown as RelayClient,
				store,
				makeTestKeypair(10),
			);
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hello from Bob",
					senderPublicKey: new Uint8Array(32).fill(1),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			await expect(
				noCallbackManager.handleIncomingRequest(envelope),
			).resolves.toBeUndefined();
		});

		it("fires via setupHandlers when request arrives over relay", async () => {
			const callback = vi.fn();
			const callbackManager = new ConnectionManager(
				mockRelay as unknown as RelayClient,
				store,
				makeTestKeypair(10),
				callback,
			);

			callbackManager.setupHandlers();
			expect(mockRelay.envelopeCallback).toBeTruthy();

			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:charlie@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hi from Charlie",
					senderPublicKey: new Uint8Array(32).fill(3),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			mockRelay.envelopeCallback!(envelope);
			await new Promise((r) => setTimeout(r, 50));

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				"pinch:charlie@localhost",
				"Hi from Charlie",
			);
		});

		it("does not reject when callback throws synchronously", async () => {
			const callbackManager = new ConnectionManager(
				mockRelay as unknown as RelayClient,
				store,
				makeTestKeypair(10),
				() => {
					throw new Error("sync callback error");
				},
			);
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hello from Bob",
					senderPublicKey: new Uint8Array(32).fill(1),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			await expect(
				callbackManager.handleIncomingRequest(envelope),
			).resolves.toBeUndefined();

			const conn = store.getConnection("pinch:bob@localhost");
			expect(conn).toBeDefined();
			expect(conn!.state).toBe("pending_inbound");
		});

		it("does not produce unhandled rejection when callback returns rejected promise", async () => {
			const callbackManager = new ConnectionManager(
				mockRelay as unknown as RelayClient,
				store,
				makeTestKeypair(10),
				async () => {
					throw new Error("async callback error");
				},
			);
			const envelope = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:bob@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hello from Bob",
					senderPublicKey: new Uint8Array(32).fill(1),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			await expect(
				callbackManager.handleIncomingRequest(envelope),
			).resolves.toBeUndefined();
		});
	});

	describe("setupHandlers", () => {
		it("registers envelope handler that dispatches by message type", async () => {
			manager.setupHandlers();

			// Verify the envelope handler was registered.
			expect(mockRelay.envelopeCallback).toBeTruthy();

			// Simulate receiving a connection request via the handler.
			const requestEnv = createIncomingEnvelope(
				MessageType.CONNECTION_REQUEST,
				"connectionRequest",
				create(ConnectionRequestSchema, {
					fromAddress: "pinch:charlie@localhost",
					toAddress: "pinch:alice@localhost",
					message: "Hi from Charlie",
					senderPublicKey: new Uint8Array(32).fill(3),
					expiresAt: BigInt(Math.floor(Date.now() / 1000) + 604800),
				}),
			);

			mockRelay.envelopeCallback!(requestEnv);

			// Give the async handler time to complete.
			await new Promise((r) => setTimeout(r, 50));

			const conn = store.getConnection("pinch:charlie@localhost");
			expect(conn).toBeDefined();
			expect(conn!.state).toBe("pending_inbound");
		});
	});
});
