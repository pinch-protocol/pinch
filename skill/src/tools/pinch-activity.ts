/**
 * pinch_activity -- Query the unified event log.
 *
 * Usage:
 *   pinch-activity [--connection <address>] [--type <event_type>]
 *                  [--since <ISO_timestamp>] [--until <ISO_timestamp>]
 *                  [--limit N] [--include-muted]
 *
 * Without flags: returns the most recent 50 events across all connections,
 * excluding muted events by default.
 *
 * Outputs JSON: { events: ActivityEvent[], count: number }
 */

import { bootstrap, shutdown } from "./cli.js";

/** Parsed CLI arguments for pinch-activity. */
export interface ActivityArgs {
	connection?: string;
	type?: string;
	since?: string;
	until?: string;
	limit: number;
	includeMuted: boolean;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): ActivityArgs {
	let connection: string | undefined;
	let type: string | undefined;
	let since: string | undefined;
	let until: string | undefined;
	let limit = 50;
	let includeMuted = false;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--connection":
				connection = args[++i];
				break;
			case "--type":
				type = args[++i];
				break;
			case "--since":
				since = args[++i];
				break;
			case "--until":
				until = args[++i];
				break;
			case "--limit": {
				const val = Number.parseInt(args[++i], 10);
				if (!Number.isNaN(val) && val > 0) limit = val;
				break;
			}
			case "--include-muted":
				includeMuted = true;
				break;
		}
	}

	return { connection, type, since, until, limit, includeMuted };
}

/** Execute the pinch_activity tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { activityFeed } = await bootstrap();

	// Exclude muted event types by default unless --include-muted is set.
	const excludeEventTypes = parsed.includeMuted
		? undefined
		: ["message_received_muted", "message_receive_muted"];

	const events = activityFeed.getEvents({
		connectionAddress: parsed.connection,
		eventType: parsed.type,
		since: parsed.since,
		until: parsed.until,
		limit: parsed.limit,
		excludeEventTypes,
	});

	console.log(JSON.stringify({ events, count: events.length }));
	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-activity.ts") ||
		process.argv[1].endsWith("pinch-activity.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
