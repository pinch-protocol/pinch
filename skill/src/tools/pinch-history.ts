#!/usr/bin/env node
/**
 * pinch_history -- Return paginated message history.
 *
 * Usage:
 *   pinch-history [--connection <address>] [--thread <id>] [--limit N] [--offset N]
 *
 * Without --connection: returns global inbox (all messages across all connections).
 * With --connection: returns per-connection messages, optionally filtered by thread.
 * Default limit=20, offset=0.
 *
 * Outputs JSON array of message records.
 */

import { bootstrap, runToolEntrypoint, shutdown } from "./cli.js";

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): {
	connection?: string;
	thread?: string;
	limit: number;
	offset: number;
} {
	let connection: string | undefined;
	let thread: string | undefined;
	let limit = 20;
	let offset = 0;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--connection":
				connection = args[++i];
				break;
			case "--thread":
				thread = args[++i];
				break;
			case "--limit": {
				const val = Number.parseInt(args[++i], 10);
				if (!Number.isNaN(val) && val > 0) limit = val;
				break;
			}
			case "--offset": {
				const val = Number.parseInt(args[++i], 10);
				if (!Number.isNaN(val) && val >= 0) offset = val;
				break;
			}
		}
	}

	return { connection, thread, limit, offset };
}

/** Execute the pinch_history tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { messageStore, messageManager } = await bootstrap();

	// Wait for any relay-queued messages to arrive before querying.
	await messageManager.waitForFlush();

	const messages = messageStore.getHistory({
		connectionAddress: parsed.connection,
		threadId: parsed.thread,
		limit: parsed.limit,
		offset: parsed.offset,
	});

	const output = messages.map((m) => ({
		id: m.id,
		connectionAddress: m.connectionAddress,
		direction: m.direction,
		body: m.body,
		threadId: m.threadId,
		replyTo: m.replyTo,
		priority: m.priority,
		sequence: m.sequence,
		state: m.state,
		attribution: m.attribution ?? null,
		createdAt: m.createdAt,
		updatedAt: m.updatedAt,
	}));

	console.log(JSON.stringify(output));
	await shutdown();
}

runToolEntrypoint("pinch-history", run);
