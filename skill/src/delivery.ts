/**
 * Delivery confirmation signing and verification for the Pinch protocol.
 *
 * When a message is delivered, the recipient signs (messageId || timestamp)
 * with their Ed25519 private key. The sender verifies the signature using
 * the recipient's Ed25519 public key, proving the message was actually
 * received by the intended party (not forged by the relay or a third party).
 */

import sodium from "libsodium-wrappers-sumo";
import { ensureSodiumReady } from "./crypto.js";

/**
 * Build the signing payload: messageId bytes concatenated with
 * timestamp as 8 big-endian bytes.
 */
function buildPayload(messageId: Uint8Array, timestamp: bigint): Uint8Array {
	const timestampBytes = new ArrayBuffer(8);
	new DataView(timestampBytes).setBigInt64(0, timestamp);
	const payload = new Uint8Array(messageId.length + 8);
	payload.set(messageId);
	payload.set(new Uint8Array(timestampBytes), messageId.length);
	return payload;
}

/**
 * Sign a delivery confirmation using Ed25519 detached signature.
 *
 * @param messageId - The message ID bytes being confirmed
 * @param timestamp - Delivery timestamp (e.g., BigInt(Date.now()))
 * @param privateKey - Signer's 64-byte Ed25519 private key
 * @returns 64-byte detached Ed25519 signature
 */
export async function signDeliveryConfirmation(
	messageId: Uint8Array,
	timestamp: bigint,
	privateKey: Uint8Array,
): Promise<Uint8Array> {
	await ensureSodiumReady();
	const payload = buildPayload(messageId, timestamp);
	return sodium.crypto_sign_detached(payload, privateKey);
}

/**
 * Verify a delivery confirmation signature.
 *
 * @param signature - 64-byte detached Ed25519 signature
 * @param messageId - The message ID bytes that were confirmed
 * @param timestamp - Delivery timestamp used during signing
 * @param senderPublicKey - Signer's 32-byte Ed25519 public key
 * @returns true if the signature is valid
 */
export async function verifyDeliveryConfirmation(
	signature: Uint8Array,
	messageId: Uint8Array,
	timestamp: bigint,
	senderPublicKey: Uint8Array,
): Promise<boolean> {
	await ensureSodiumReady();
	const payload = buildPayload(messageId, timestamp);
	return sodium.crypto_sign_verify_detached(signature, payload, senderPublicKey);
}
