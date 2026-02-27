import { describe, it, expect } from "vitest";
import { generateKeypair } from "./identity.js";
import {
	signDeliveryConfirmation,
	verifyDeliveryConfirmation,
} from "./delivery.js";

describe("Delivery Confirmation", () => {
	const messageId = new TextEncoder().encode("test-message-id-001");
	const timestamp = BigInt(1700000000000);

	it("signDeliveryConfirmation returns a 64-byte signature", async () => {
		const keypair = await generateKeypair();
		const signature = await signDeliveryConfirmation(
			messageId,
			timestamp,
			keypair.privateKey,
		);

		expect(signature).toBeInstanceOf(Uint8Array);
		expect(signature.length).toBe(64);
	});

	it("verifyDeliveryConfirmation returns true for valid signature", async () => {
		const keypair = await generateKeypair();
		const signature = await signDeliveryConfirmation(
			messageId,
			timestamp,
			keypair.privateKey,
		);

		const valid = await verifyDeliveryConfirmation(
			signature,
			messageId,
			timestamp,
			keypair.publicKey,
		);
		expect(valid).toBe(true);
	});

	it("verifyDeliveryConfirmation returns false for wrong public key", async () => {
		const signer = await generateKeypair();
		const other = await generateKeypair();
		const signature = await signDeliveryConfirmation(
			messageId,
			timestamp,
			signer.privateKey,
		);

		const valid = await verifyDeliveryConfirmation(
			signature,
			messageId,
			timestamp,
			other.publicKey,
		);
		expect(valid).toBe(false);
	});

	it("verifyDeliveryConfirmation returns false for tampered message_id", async () => {
		const keypair = await generateKeypair();
		const signature = await signDeliveryConfirmation(
			messageId,
			timestamp,
			keypair.privateKey,
		);

		const tamperedId = new TextEncoder().encode("tampered-message-id");
		const valid = await verifyDeliveryConfirmation(
			signature,
			tamperedId,
			timestamp,
			keypair.publicKey,
		);
		expect(valid).toBe(false);
	});

	it("verifyDeliveryConfirmation returns false for tampered timestamp", async () => {
		const keypair = await generateKeypair();
		const signature = await signDeliveryConfirmation(
			messageId,
			timestamp,
			keypair.privateKey,
		);

		const tamperedTimestamp = BigInt(9999999999999);
		const valid = await verifyDeliveryConfirmation(
			signature,
			messageId,
			tamperedTimestamp,
			keypair.publicKey,
		);
		expect(valid).toBe(false);
	});

	it("round-trip: sign then verify with correct keys succeeds", async () => {
		const keypair = await generateKeypair();
		const msgId = new TextEncoder().encode("round-trip-test-msg");
		const ts = BigInt(Date.now());

		const signature = await signDeliveryConfirmation(
			msgId,
			ts,
			keypair.privateKey,
		);

		const valid = await verifyDeliveryConfirmation(
			signature,
			msgId,
			ts,
			keypair.publicKey,
		);
		expect(valid).toBe(true);
	});
});
