/**
 * pinch_send -- Encrypt and send a message to a connected peer.
 *
 * Usage:
 *   pinch-send --to <address> --body <text> [--thread <id>] [--reply-to <id>] [--priority low|normal|urgent]
 *
 * Outputs JSON: { "message_id": "<id>", "status": "sent" }
 */

import { bootstrap, shutdown } from "./cli.js";

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): {
	to: string;
	body: string;
	thread?: string;
	replyTo?: string;
	priority?: "low" | "normal" | "urgent";
} {
	let to = "";
	let body = "";
	let thread: string | undefined;
	let replyTo: string | undefined;
	let priority: "low" | "normal" | "urgent" | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--to":
				to = args[++i] ?? "";
				break;
			case "--body":
				body = args[++i] ?? "";
				break;
			case "--thread":
				thread = args[++i];
				break;
			case "--reply-to":
				replyTo = args[++i];
				break;
			case "--priority": {
				const val = args[++i];
				if (val === "low" || val === "normal" || val === "urgent") {
					priority = val;
				}
				break;
			}
		}
	}

	if (!to) throw new Error("--to is required");
	if (!body) throw new Error("--body is required");

	return { to, body, thread, replyTo, priority };
}

/** Execute the pinch_send tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { messageManager } = await bootstrap();

	const messageId = await messageManager.sendMessage({
		recipient: parsed.to,
		body: parsed.body,
		threadId: parsed.thread,
		replyTo: parsed.replyTo,
		priority: parsed.priority,
	});

	console.log(JSON.stringify({ message_id: messageId, status: "sent" }));
	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-send.ts") ||
		process.argv[1].endsWith("pinch-send.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
