/**
 * pinch_accept -- Approve a pending inbound connection request.
 *
 * Sends a ConnectionResponse protobuf (accepted=true) over WebSocket,
 * transitions the connection state from pending_inbound → active,
 * and saves the store.
 *
 * Usage:
 *   pinch-accept --connection <address>
 *
 * Outputs JSON: { "status": "accepted", "connection": "<address>" }
 */

import {
	bootstrap,
	parseConnectionArg,
	runToolEntrypoint,
	shutdown,
} from "./cli.js";

/** Parsed arguments for pinch_accept. */
export interface AcceptArgs {
	connection: string;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): AcceptArgs {
	const { connection } = parseConnectionArg(args);
	return { connection };
}

/** Execute the pinch_accept tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { connectionManager } = await bootstrap();

	await connectionManager.approveRequest(parsed.connection);

	console.log(
		JSON.stringify({
			status: "accepted",
			connection: parsed.connection,
		}),
	);

	await shutdown();
}

runToolEntrypoint("pinch-accept", run);
