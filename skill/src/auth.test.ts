import { describe, expect, it, beforeAll } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import { ensureSodiumReady } from "./crypto.js";
import { signChallenge } from "./auth.js";

beforeAll(async () => {
	await ensureSodiumReady();
});

describe("signChallenge", () => {
	it("produces a 64-byte signature", async () => {
		const kp = sodium.crypto_sign_keypair();
		const nonce = sodium.randombytes_buf(32);

		const sig = await signChallenge(nonce, kp.privateKey);

		expect(sig).toBeInstanceOf(Uint8Array);
		expect(sig.length).toBe(64);
	});

	it("signature verifies with crypto_sign_verify_detached", async () => {
		const kp = sodium.crypto_sign_keypair();
		const nonce = sodium.randombytes_buf(32);

		const sig = await signChallenge(nonce, kp.privateKey);

		const valid = sodium.crypto_sign_verify_detached(sig, nonce, kp.publicKey);
		expect(valid).toBe(true);
	});

	it("different nonces produce different signatures", async () => {
		const kp = sodium.crypto_sign_keypair();
		const nonce1 = sodium.randombytes_buf(32);
		const nonce2 = sodium.randombytes_buf(32);

		const sig1 = await signChallenge(nonce1, kp.privateKey);
		const sig2 = await signChallenge(nonce2, kp.privateKey);

		// Signatures for different nonces must differ
		const equal =
			sig1.length === sig2.length &&
			sig1.every((byte, i) => byte === sig2[i]);
		expect(equal).toBe(false);
	});

	it("wrong key produces a signature that does not verify", async () => {
		const kp1 = sodium.crypto_sign_keypair();
		const kp2 = sodium.crypto_sign_keypair();
		const nonce = sodium.randombytes_buf(32);

		// Sign with kp1's private key
		const sig = await signChallenge(nonce, kp1.privateKey);

		// Verify with kp2's public key -- should fail
		const valid = sodium.crypto_sign_verify_detached(
			sig,
			nonce,
			kp2.publicKey,
		);
		expect(valid).toBe(false);
	});
});
