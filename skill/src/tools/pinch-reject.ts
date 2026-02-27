/**
 * pinch_reject -- Silently reject a pending inbound connection request.
 *
 * No network message is sent to the requester (silent rejection per protocol).
 * Transitions the connection state from pending_inbound → revoked locally
 * and saves the store.
 *
 * Usage:
 *   pinch-reject --connection <address>
 *
 * Outputs JSON: { "status": "rejected", "connection": "<address>" }
 */

import {
	bootstrap,
	parseConnectionArg,
	runToolEntrypoint,
	shutdown,
} from "./cli.js";

/** Parsed arguments for pinch_reject. */
export interface RejectArgs {
	connection: string;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): RejectArgs {
	const { connection } = parseConnectionArg(args);
	return { connection };
}

/** Execute the pinch_reject tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { connectionManager } = await bootstrap();

	await connectionManager.rejectRequest(parsed.connection);

	console.log(
		JSON.stringify({
			status: "rejected",
			connection: parsed.connection,
		}),
	);

	await shutdown();
}

runToolEntrypoint("pinch-reject", run);
