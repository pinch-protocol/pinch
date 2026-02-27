/**
 * pinch_connect -- Send a connection request to a pinch address.
 *
 * Usage:
 *   pinch-connect --to <address> --message <text>
 *
 * Outputs JSON: { "status": "request_sent", "to": "<address>" }
 */

import { bootstrap, shutdown } from "./cli.js";

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): {
	to: string;
	message: string;
} {
	let to = "";
	let message = "";

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--to":
				to = args[++i] ?? "";
				break;
			case "--message":
				message = args[++i] ?? "";
				break;
		}
	}

	if (!to) throw new Error("--to is required");
	if (!message) throw new Error("--message is required");

	return { to, message };
}

/** Execute the pinch_connect tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { connectionManager } = await bootstrap();

	await connectionManager.sendRequest(parsed.to, parsed.message);

	console.log(
		JSON.stringify({ status: "request_sent", to: parsed.to }),
	);
	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-connect.ts") ||
		process.argv[1].endsWith("pinch-connect.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
