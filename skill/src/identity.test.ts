import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	generateKeypair,
	saveKeypair,
	loadKeypair,
	generateAddress,
	validateAddress,
} from "./identity.js";
import { ensureSodiumReady } from "./crypto.js";

interface IdentityVector {
	ed25519_seed: string;
	ed25519_public_key: string;
	ed25519_private_key: string;
	x25519_public_key: string;
	x25519_private_key: string;
	address: string;
}

function loadIdentityVectors(): IdentityVector[] {
	const data = readFileSync(
		resolve(__dirname, "../../testdata/identity_vectors.json"),
		"utf-8",
	);
	return JSON.parse(data).vectors;
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

beforeAll(async () => {
	await ensureSodiumReady();
});

describe("generateKeypair", () => {
	it("generates a keypair with correct key sizes", async () => {
		const kp = await generateKeypair();
		expect(kp.publicKey).toBeInstanceOf(Uint8Array);
		expect(kp.privateKey).toBeInstanceOf(Uint8Array);
		expect(kp.publicKey.length).toBe(32);
		expect(kp.privateKey.length).toBe(64);
	});
});

describe("saveKeypair and loadKeypair", () => {
	it("saves and loads a keypair, producing the same address", async () => {
		const kp = await generateKeypair();
		const addr1 = generateAddress(kp.publicKey, "test.relay.example.com");

		const tmpDir = mkdtempSync(join(tmpdir(), "pinch-test-"));
		const keyPath = join(tmpDir, "identity.json");

		try {
			await saveKeypair(kp, keyPath);
			const loaded = await loadKeypair(keyPath);

			expect(bytesToHex(loaded.publicKey)).toBe(bytesToHex(kp.publicKey));
			expect(bytesToHex(loaded.privateKey)).toBe(bytesToHex(kp.privateKey));

			const addr2 = generateAddress(
				loaded.publicKey,
				"test.relay.example.com",
			);
			expect(addr2).toBe(addr1);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("writes new keypair files with owner-only permissions", async () => {
		const kp = await generateKeypair();
		const tmpDir = mkdtempSync(join(tmpdir(), "pinch-test-perms-"));
		const keyPath = join(tmpDir, "identity.json");

		try {
			await saveKeypair(kp, keyPath);
			const mode = statSync(keyPath).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("corrects permissions on existing keypair files to owner-only", async () => {
		const kp = await generateKeypair();
		const tmpDir = mkdtempSync(join(tmpdir(), "pinch-test-perms-"));
		const keyPath = join(tmpDir, "identity.json");

		try {
			writeFileSync(keyPath, "{}\n", { mode: 0o644 });
			chmodSync(keyPath, 0o644);
			await saveKeypair(kp, keyPath);
			const mode = statSync(keyPath).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("generateAddress", () => {
	it("generates addresses matching test vectors", () => {
		const vectors = loadIdentityVectors();
		for (const v of vectors) {
			const pubKey = hexToBytes(v.ed25519_public_key);
			const addr = generateAddress(pubKey, "test.relay.example.com");
			expect(addr).toBe(v.address);
		}
	});
});

describe("validateAddress", () => {
	it("validates correct addresses", () => {
		const vectors = loadIdentityVectors();
		for (const v of vectors) {
			const result = validateAddress(v.address);
			expect(bytesToHex(result.pubKey)).toBe(v.ed25519_public_key);
			expect(result.host).toBe("test.relay.example.com");
		}
	});

	it("rejects tampered addresses", () => {
		const invalidAddresses = [
			"pinch:INVALID@test.relay.example.com",
			"pinch:111111111111111111111111111111111111111111111111111@test.relay.example.com",
			"not-an-address",
			"",
			"pinch:@test.relay.example.com",
			"pinch:abc",
		];

		for (const addr of invalidAddresses) {
			expect(() => validateAddress(addr)).toThrow();
		}
	});
});
