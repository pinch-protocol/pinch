/**
 * pinch_intervene -- Enter/exit passthrough mode and send human-attributed messages.
 *
 * Usage:
 *   pinch-intervene --start --connection <address>              # Enter passthrough mode
 *   pinch-intervene --stop --connection <address>               # Exit passthrough mode (handback)
 *   pinch-intervene --send --connection <address> --body <text> # Send human-attributed message
 *
 * Outputs JSON: { "status": "...", "connection": "<address>" }
 */

import { bootstrap, shutdown } from "./cli.js";

/** Parsed arguments for pinch_intervene. */
export interface InterveneArgs {
	mode: "start" | "stop" | "send";
	connection: string;
	body?: string;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): InterveneArgs {
	let start = false;
	let stop = false;
	let send = false;
	let connection = "";
	let body: string | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--start":
				start = true;
				break;
			case "--stop":
				stop = true;
				break;
			case "--send":
				send = true;
				break;
			case "--connection":
				connection = args[++i] ?? "";
				break;
			case "--body":
				body = args[++i] ?? "";
				break;
		}
	}

	if (!connection) throw new Error("--connection is required");

	const modeCount = [start, stop, send].filter(Boolean).length;
	if (modeCount !== 1) {
		throw new Error("Exactly one of --start, --stop, or --send is required");
	}

	const mode = start ? "start" : stop ? "stop" : "send";

	if (mode === "send" && !body) {
		throw new Error("--body is required with --send");
	}

	return { mode, connection, body };
}

/** Execute the pinch_intervene tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { connectionStore, messageManager, activityFeed } = await bootstrap();

	switch (parsed.mode) {
		case "start": {
			connectionStore.updateConnection(parsed.connection, {
				passthrough: true,
			});
			await connectionStore.save();
			activityFeed.record({
				connectionAddress: parsed.connection,
				eventType: "intervention_started",
				actionType: "intervention_started",
				badge: "intervention",
			});
			console.log(
				JSON.stringify({
					status: "passthrough_active",
					connection: parsed.connection,
				}),
			);
			break;
		}
		case "stop": {
			connectionStore.updateConnection(parsed.connection, {
				passthrough: false,
			});
			await connectionStore.save();
			activityFeed.record({
				connectionAddress: parsed.connection,
				eventType: "intervention_ended",
				actionType: "intervention_ended",
				badge: "intervention",
			});
			console.log(
				JSON.stringify({
					status: "passthrough_ended",
					connection: parsed.connection,
				}),
			);
			break;
		}
		case "send": {
			const messageId = await messageManager.sendMessage({
				recipient: parsed.connection,
				body: parsed.body!,
				attribution: "human",
			});
			console.log(
				JSON.stringify({
					message_id: messageId,
					status: "sent",
					attribution: "human",
				}),
			);
			break;
		}
	}

	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-intervene.ts") ||
		process.argv[1].endsWith("pinch-intervene.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
