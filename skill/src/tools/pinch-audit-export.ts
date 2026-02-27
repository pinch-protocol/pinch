/**
 * pinch_audit_export -- Export the audit log to a JSON file for independent verification.
 *
 * Usage:
 *   pinch-audit-export --output <path>
 *   pinch-audit-export [--since <ISO>] [--until <ISO>] --output <path>
 *
 * Exports all activity_events (with hash chain data) to a JSON file.
 * Supports optional time range filtering.
 *
 * Outputs JSON to stdout: { exported: N, path: "/path/to/export.json" }
 */

import { writeFile } from "node:fs/promises";
import { bootstrapLocal, shutdownLocal } from "./cli.js";

/** Parsed CLI arguments for pinch-audit-export. */
export interface AuditExportArgs {
	output: string;
	since?: string;
	until?: string;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): AuditExportArgs {
	let output: string | undefined;
	let since: string | undefined;
	let until: string | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--output":
				output = args[++i];
				if (output === undefined) {
					throw new Error("--output requires a file path");
				}
				break;
			case "--since":
				since = args[++i];
				break;
			case "--until":
				until = args[++i];
				break;
		}
	}

	if (!output) {
		throw new Error("--output is required");
	}

	return { output, since, until };
}

/** Execute the pinch_audit_export tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { messageStore } = await bootstrapLocal();
	const db = messageStore.getDb();

	// Build query with optional time range filters.
	const conditions: string[] = [];
	const params: Record<string, unknown> = {};

	if (parsed.since) {
		conditions.push("created_at >= @since");
		params.since = parsed.since;
	}
	if (parsed.until) {
		conditions.push("created_at <= @until");
		params.until = parsed.until;
	}

	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const sql = `
		SELECT id, connection_address, event_type, message_id, badge,
		       details, created_at, actor_pubkey, action_type,
		       message_hash, prev_hash, entry_hash
		FROM activity_events
		${where}
		ORDER BY created_at ASC, id ASC
	`;

	const rows = (
		conditions.length > 0
			? db.prepare(sql).all(params)
			: db.prepare(sql).all()
	) as Record<string, unknown>[];

	const entries = rows.map((row) => ({
		id: row.id as string,
		connection_address: row.connection_address as string,
		event_type: row.event_type as string,
		message_id: (row.message_id as string) ?? null,
		badge: (row.badge as string) ?? null,
		details: (row.details as string) ?? null,
		created_at: row.created_at as string,
		actor_pubkey: (row.actor_pubkey as string) ?? null,
		action_type: (row.action_type as string) ?? null,
		message_hash: (row.message_hash as string) ?? null,
		prev_hash: (row.prev_hash as string) ?? null,
		entry_hash: (row.entry_hash as string) ?? null,
	}));

	const exportData = {
		exported_at: new Date().toISOString(),
		total_entries: entries.length,
		entries,
	};

	await writeFile(parsed.output, JSON.stringify(exportData, null, 2), "utf-8");

	console.log(
		JSON.stringify({ exported: entries.length, path: parsed.output }),
	);
	await shutdownLocal();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-audit-export.ts") ||
		process.argv[1].endsWith("pinch-audit-export.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
