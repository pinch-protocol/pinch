import { describe, expect, it } from "vitest";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	EncryptedPayloadSchema,
	PlaintextPayloadSchema,
	HandshakeSchema,
	AuthChallengeSchema,
	AuthResponseSchema,
	MessageType,
	MessageTypeSchema,
} from "@pinch/proto/pinch/v1/envelope_pb.js";

describe("Envelope serialization round-trip", () => {
	it("should round-trip an Envelope with EncryptedPayload", () => {
		const messageId = new Uint8Array([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
		]);
		const senderPubKey = new Uint8Array(32);
		for (let i = 0; i < 32; i++) senderPubKey[i] = i;
		const nonce = new Uint8Array(24);
		for (let i = 0; i < 24; i++) nonce[i] = i + 100;
		const ciphertext = new TextEncoder().encode("encrypted-data-here");

		const original = create(EnvelopeSchema, {
			version: 1,
			fromAddress: "pinch:abc123@relay.example.com",
			toAddress: "pinch:def456@relay.example.com",
			type: MessageType.MESSAGE,
			messageId,
			timestamp: BigInt(Date.now()),
			payload: {
				case: "encrypted",
				value: create(EncryptedPayloadSchema, {
					nonce,
					ciphertext,
					senderPublicKey: senderPubKey,
				}),
			},
		});

		// Serialize
		const data = toBinary(EnvelopeSchema, original);
		expect(data).toBeInstanceOf(Uint8Array);
		expect(data.length).toBeGreaterThan(0);

		// Deserialize
		const decoded = fromBinary(EnvelopeSchema, data);

		// Verify all fields
		expect(decoded.version).toBe(1);
		expect(decoded.fromAddress).toBe("pinch:abc123@relay.example.com");
		expect(decoded.toAddress).toBe("pinch:def456@relay.example.com");
		expect(decoded.type).toBe(MessageType.MESSAGE);
		expect(decoded.messageId).toEqual(messageId);
		expect(decoded.timestamp).toBe(original.timestamp);

		// Verify oneof payload discrimination
		expect(decoded.payload.case).toBe("encrypted");
		if (decoded.payload.case === "encrypted") {
			expect(decoded.payload.value.nonce).toEqual(nonce);
			expect(decoded.payload.value.ciphertext).toEqual(ciphertext);
			expect(decoded.payload.value.senderPublicKey).toEqual(senderPubKey);
		}
	});

	it("should round-trip an Envelope with Handshake payload", () => {
		const signingKey = new Uint8Array(32);
		const encryptionKey = new Uint8Array(32);
		for (let i = 0; i < 32; i++) {
			signingKey[i] = i;
			encryptionKey[i] = i + 32;
		}

		const original = create(EnvelopeSchema, {
			version: 1,
			fromAddress: "pinch:abc123@relay.example.com",
			type: MessageType.HANDSHAKE,
			payload: {
				case: "handshake",
				value: create(HandshakeSchema, {
					version: 1,
					signingKey,
					encryptionKey,
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, original);
		const decoded = fromBinary(EnvelopeSchema, data);

		expect(decoded.payload.case).toBe("handshake");
		if (decoded.payload.case === "handshake") {
			expect(decoded.payload.value.version).toBe(1);
			expect(decoded.payload.value.signingKey).toEqual(signingKey);
			expect(decoded.payload.value.encryptionKey).toEqual(encryptionKey);
		}
	});

	it("should round-trip an Envelope with AuthChallenge payload", () => {
		const nonce = new Uint8Array(32);
		for (let i = 0; i < nonce.length; i++) nonce[i] = i + 11;
		const now = BigInt(Date.now());

		const original = create(EnvelopeSchema, {
			version: 1,
			type: MessageType.AUTH_CHALLENGE,
			timestamp: now,
			payload: {
				case: "authChallenge",
				value: create(AuthChallengeSchema, {
					version: 1,
					nonce,
					issuedAtMs: now,
					expiresAtMs: now + 10_000n,
					relayHost: "relay.example.com",
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, original);
		const decoded = fromBinary(EnvelopeSchema, data);

		expect(decoded.payload.case).toBe("authChallenge");
		if (decoded.payload.case === "authChallenge") {
			expect(decoded.payload.value.version).toBe(1);
			expect(decoded.payload.value.nonce).toEqual(nonce);
			expect(decoded.payload.value.issuedAtMs).toBe(now);
			expect(decoded.payload.value.expiresAtMs).toBe(now + 10_000n);
			expect(decoded.payload.value.relayHost).toBe("relay.example.com");
		}
	});

	it("should round-trip an Envelope with AuthResponse payload", () => {
		const publicKey = new Uint8Array(32);
		const signature = new Uint8Array(64);
		const nonce = new Uint8Array(32);
		for (let i = 0; i < publicKey.length; i++) {
			publicKey[i] = i;
			nonce[i] = 100 + i;
		}
		for (let i = 0; i < signature.length; i++) {
			signature[i] = 200 + (i % 32);
		}

		const original = create(EnvelopeSchema, {
			version: 1,
			type: MessageType.AUTH_RESPONSE,
			payload: {
				case: "authResponse",
				value: create(AuthResponseSchema, {
					version: 1,
					publicKey,
					signature,
					nonce,
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, original);
		const decoded = fromBinary(EnvelopeSchema, data);

		expect(decoded.payload.case).toBe("authResponse");
		if (decoded.payload.case === "authResponse") {
			expect(decoded.payload.value.version).toBe(1);
			expect(decoded.payload.value.publicKey).toEqual(publicKey);
			expect(decoded.payload.value.signature).toEqual(signature);
			expect(decoded.payload.value.nonce).toEqual(nonce);
		}
	});
});

describe("PlaintextPayload serialization round-trip", () => {
	it("should round-trip PlaintextPayload with all fields", () => {
		const content = new TextEncoder().encode("hello");
		const now = BigInt(Date.now());

		const original = create(PlaintextPayloadSchema, {
			version: 1,
			sequence: 42n,
			timestamp: now,
			content,
			contentType: "text/plain",
		});

		const data = toBinary(PlaintextPayloadSchema, original);
		const decoded = fromBinary(PlaintextPayloadSchema, data);

		expect(decoded.version).toBe(1);
		expect(decoded.sequence).toBe(42n);
		expect(decoded.timestamp).toBe(now);
		expect(decoded.content).toEqual(content);
		expect(decoded.contentType).toBe("text/plain");
	});
});

describe("MessageType enum values", () => {
	it("should have correct integer values", () => {
		expect(MessageType.UNSPECIFIED).toBe(0);
		expect(MessageType.HANDSHAKE).toBe(1);
		expect(MessageType.AUTH_CHALLENGE).toBe(2);
		expect(MessageType.AUTH_RESPONSE).toBe(3);
		expect(MessageType.MESSAGE).toBe(4);
		expect(MessageType.DELIVERY_CONFIRM).toBe(5);
		expect(MessageType.CONNECTION_REQUEST).toBe(6);
		expect(MessageType.CONNECTION_RESPONSE).toBe(7);
		expect(MessageType.HEARTBEAT).toBe(8);
	});
});
