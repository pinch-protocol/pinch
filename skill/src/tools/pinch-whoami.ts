#!/usr/bin/env node
/**
 * pinch-whoami -- Print this agent's Pinch identity and optionally register
 * with the relay.
 *
 * Usage:
 *   pinch-whoami               # Print address, keypair path, relay URL
 *   pinch-whoami --register    # Also POST /agents/register; print claim code
 *
 * Environment variables:
 *   PINCH_KEYPAIR_PATH  Path to keypair JSON (default: ~/.pinch/keypair.json)
 *   PINCH_RELAY_HOST    Relay hostname for address derivation (default: localhost)
 *   PINCH_RELAY_URL     WebSocket URL (required for --register)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadKeypair, generateKeypair, saveKeypair, generateAddress } from "../identity.js";
import { ensureSodiumReady } from "../crypto.js";
import sodium from "libsodium-wrappers-sumo";
import { relayBaseUrl } from "./relay-url.js";

/** Execute the pinch-whoami tool. */
export async function run(args: string[]): Promise<void> {
	const doRegister = args.includes("--register");

	await ensureSodiumReady();

	const keypairPath =
		process.env.PINCH_KEYPAIR_PATH ??
		join(homedir(), ".pinch", "keypair.json");
	const relayHost = process.env.PINCH_RELAY_HOST ?? "localhost";
	const relayUrl = process.env.PINCH_RELAY_URL ?? "";

	// Load or generate keypair.
	let keypair: Awaited<ReturnType<typeof loadKeypair>>;
	try {
		keypair = await loadKeypair(keypairPath);
	} catch {
		keypair = await generateKeypair();
		await saveKeypair(keypair, keypairPath);
	}

	const address = generateAddress(keypair.publicKey, relayHost);

	console.log(`Address:  ${address}`);
	console.log(`Keypair:  ${keypairPath}`);
	console.log(`Relay:    ${relayUrl || "(not set)"}`);

	if (!doRegister) {
		return;
	}

	if (!relayUrl) {
		console.error("Error: PINCH_RELAY_URL is required for --register");
		process.exit(1);
	}

	const baseUrl = relayBaseUrl(relayUrl);
	const pubKeyB64 = sodium.to_base64(
		keypair.publicKey,
		sodium.base64_variants.ORIGINAL,
	);

	const response = await fetch(`${baseUrl}/agents/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ public_key: pubKeyB64 }),
	});

	if (!response.ok) {
		const text = await response.text();
		console.error(`Error: registration failed (${response.status}): ${text.trim()}`);
		process.exit(1);
	}

	const result = (await response.json()) as { address: string; claim_code: string };

	console.log();
	console.log(`Claim code:  ${result.claim_code}`);
	console.log(`To approve:  Visit ${baseUrl}/claim and enter the code`);
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-whoami") ||
		process.argv[1].endsWith("pinch-whoami.ts") ||
		process.argv[1].endsWith("pinch-whoami.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(`Error: ${String(err.message ?? err)}`);
		process.exit(1);
	});
}
