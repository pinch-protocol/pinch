/**
 * Ed25519 keypair generation, persistence, and address derivation for the
 * Pinch protocol.
 *
 * Address format: pinch:<base58(pubkey + sha256(pubkey)[0:4])>@<host>
 *
 * IMPORTANT: Call ensureSodiumReady() before using any identity functions.
 */

import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import sodium from "libsodium-wrappers-sumo";
import bs58 from "bs58";
import { ensureSodiumReady } from "./crypto.js";

export interface Keypair {
	publicKey: Uint8Array;
	privateKey: Uint8Array;
}

interface KeypairFile {
	version: number;
	public_key: string;
	private_key: string;
	created_at: string;
}

const ADDRESS_REGEX = /^pinch:([1-9A-HJ-NP-Za-km-z]+)@(.+)$/;

/**
 * Generates a new Ed25519 keypair using libsodium.
 * @returns Keypair with 32-byte public key and 64-byte private key
 */
export async function generateKeypair(): Promise<Keypair> {
	await ensureSodiumReady();
	const kp = sodium.crypto_sign_keypair();
	return {
		publicKey: kp.publicKey,
		privateKey: kp.privateKey,
	};
}

/**
 * Saves a keypair to disk as JSON with base64-encoded keys.
 * @param keypair - The keypair to save
 * @param path - File path to write to
 */
export async function saveKeypair(
	keypair: Keypair,
	path: string,
): Promise<void> {
	const data: KeypairFile = {
		version: 1,
		public_key: sodium.to_base64(
			keypair.publicKey,
			sodium.base64_variants.ORIGINAL,
		),
		private_key: sodium.to_base64(
			keypair.privateKey,
			sodium.base64_variants.ORIGINAL,
		),
		created_at: new Date().toISOString(),
	};
	await writeFile(path, JSON.stringify(data, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	await chmod(path, 0o600);
}

/**
 * Loads a keypair from a JSON file on disk.
 * @param path - File path to read from
 * @returns The loaded keypair
 * @throws If the file format is invalid or version is unsupported
 */
export async function loadKeypair(path: string): Promise<Keypair> {
	await ensureSodiumReady();
	const content = await readFile(path, "utf-8");
	const data: KeypairFile = JSON.parse(content);

	if (data.version !== 1) {
		throw new Error(`Unsupported keypair file version: ${data.version}`);
	}

	return {
		publicKey: sodium.from_base64(
			data.public_key,
			sodium.base64_variants.ORIGINAL,
		),
		privateKey: sodium.from_base64(
			data.private_key,
			sodium.base64_variants.ORIGINAL,
		),
	};
}

/**
 * Generates a Pinch address from an Ed25519 public key and relay host.
 * Format: pinch:<base58(pubkey + sha256(pubkey)[0:4])>@<host>
 * @param pubKey - 32-byte Ed25519 public key
 * @param relayHost - Relay hostname
 * @returns Formatted Pinch address string
 */
export function generateAddress(pubKey: Uint8Array, relayHost: string): string {
	const hash = createHash("sha256").update(pubKey).digest();
	const checksum = hash.subarray(0, 4);
	const payload = new Uint8Array(36);
	payload.set(pubKey);
	payload.set(checksum, 32);
	const encoded = bs58.encode(payload);
	return `pinch:${encoded}@${relayHost}`;
}

/**
 * Validates a Pinch address, extracting the public key and host.
 * Verifies the address format and checksum.
 * @param addr - Pinch address string
 * @returns Object with pubKey (Uint8Array) and host (string)
 * @throws If the address format is invalid or checksum doesn't match
 */
export function validateAddress(addr: string): {
	pubKey: Uint8Array;
	host: string;
} {
	const match = ADDRESS_REGEX.exec(addr);
	if (!match) {
		throw new Error(`Invalid address format: ${addr}`);
	}

	const [, encodedPayload, host] = match;
	const decoded = bs58.decode(encodedPayload);

	if (decoded.length !== 36) {
		throw new Error(
			`Invalid address payload length: expected 36, got ${decoded.length}`,
		);
	}

	const pubKey = decoded.slice(0, 32);
	const checksum = decoded.slice(32, 36);

	const hash = createHash("sha256").update(pubKey).digest();
	const expectedChecksum = hash.subarray(0, 4);

	for (let i = 0; i < 4; i++) {
		if (checksum[i] !== expectedChecksum[i]) {
			throw new Error("Address checksum mismatch");
		}
	}

	return { pubKey: Uint8Array.from(pubKey), host };
}
