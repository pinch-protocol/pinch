/**
 * pinch_contacts -- List connections with status and autonomy level.
 *
 * Usage:
 *   pinch-contacts [--state active|pending_inbound|pending_outbound|blocked|revoked]
 *
 * Outputs JSON array of connections with: address, state, autonomyLevel, nickname, lastActivity
 */

import { bootstrap, shutdown } from "./cli.js";
import type { ConnectionState } from "../connection-store.js";

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): {
	state?: ConnectionState;
} {
	let state: ConnectionState | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--state") {
			const val = args[++i];
			if (
				val === "active" ||
				val === "pending_inbound" ||
				val === "pending_outbound" ||
				val === "blocked" ||
				val === "revoked"
			) {
				state = val;
			}
		}
	}

	return { state };
}

/** Execute the pinch_contacts tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { connectionStore } = await bootstrap();

	const connections = connectionStore.listConnections(
		parsed.state ? { state: parsed.state } : undefined,
	);

	const output = connections.map((c) => ({
		address: c.peerAddress,
		state: c.state,
		autonomyLevel: c.autonomyLevel,
		nickname: c.nickname,
		lastActivity: c.lastActivity,
	}));

	console.log(JSON.stringify(output));
	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-contacts.ts") ||
		process.argv[1].endsWith("pinch-contacts.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
