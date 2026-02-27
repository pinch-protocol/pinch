/**
 * pinch_mute -- Mute or unmute a connection.
 *
 * Muted connections still receive messages (delivery confirmations sent)
 * but messages are not surfaced to the agent or human. The sender has
 * no indication they have been muted.
 *
 * Usage:
 *   pinch-mute --connection <address>             # Mute a connection
 *   pinch-mute --unmute --connection <address>     # Unmute a connection
 *
 * Outputs JSON: { "status": "muted"|"unmuted", "connection": "<address>" }
 */

import { bootstrap, shutdown } from "./cli.js";

/** Parsed arguments for pinch_mute. */
export interface MuteArgs {
	connection: string;
	unmute: boolean;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): MuteArgs {
	let connection = "";
	let unmute = false;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--connection":
				connection = args[++i] ?? "";
				break;
			case "--unmute":
				unmute = true;
				break;
		}
	}

	if (!connection) throw new Error("--connection is required");

	return { connection, unmute };
}

/** Execute the pinch_mute tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { connectionStore, activityFeed } = await bootstrap();

	connectionStore.updateConnection(parsed.connection, {
		muted: !parsed.unmute,
	});
	await connectionStore.save();

	const status = parsed.unmute ? "unmuted" : "muted";
	activityFeed.record({
		connectionAddress: parsed.connection,
		eventType: parsed.unmute ? "connection_unmuted" : "connection_muted",
		actionType: parsed.unmute ? "connection_unmuted" : "connection_muted",
		badge: "muted",
	});

	console.log(
		JSON.stringify({
			status,
			connection: parsed.connection,
		}),
	);

	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-mute.ts") ||
		process.argv[1].endsWith("pinch-mute.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
