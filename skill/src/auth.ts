/**
 * Ed25519 challenge signing for the Pinch relay auth handshake.
 *
 * The relay sends a random nonce (AuthChallenge); the agent signs it
 * with its Ed25519 private key and sends back the signature + public key
 * (AuthResponse). The relay verifies and assigns the agent its pinch: address.
 *
 * IMPORTANT: Call ensureSodiumReady() before using signChallenge.
 */

import sodium from "libsodium-wrappers-sumo";
import { ensureSodiumReady } from "./crypto.js";

/**
 * Signs a challenge nonce with the agent's Ed25519 private key.
 * @param nonce - The challenge nonce bytes from the relay (typically 32 bytes)
 * @param privateKey - 64-byte Ed25519 private key
 * @returns 64-byte Ed25519 detached signature
 */
export async function signChallenge(
	nonce: Uint8Array,
	privateKey: Uint8Array,
): Promise<Uint8Array> {
	await ensureSodiumReady();
	return sodium.crypto_sign_detached(nonce, privateKey);
}
