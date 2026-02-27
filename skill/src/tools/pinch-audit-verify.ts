/**
 * pinch_audit_verify -- Verify the integrity of the tamper-evident audit log hash chain.
 *
 * Usage:
 *   pinch-audit-verify [--tail <N>]
 *
 * Walks the SHA-256 hash chain and reports pass/fail. Optionally verify
 * only the most recent N entries.
 *
 * Outputs JSON:
 *   On success: { valid: true, total_entries, verified_entries, genesis_id, latest_id }
 *   On failure: { valid: false, total_entries, first_broken_at, broken_index, expected_hash, actual_hash }
 */

import { bootstrapLocal, shutdownLocal } from "./cli.js";
import { computeEntryHash } from "../autonomy/activity-feed.js";

/** Parsed CLI arguments for pinch-audit-verify. */
export interface AuditVerifyArgs {
	tail?: number;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): AuditVerifyArgs {
	let tail: number | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--tail": {
				const raw = args[++i];
				if (raw === undefined) {
					throw new Error("--tail requires a number");
				}
				const val = Number.parseInt(raw, 10);
				if (Number.isNaN(val) || val <= 0) {
					throw new Error("--tail requires a positive number");
				}
				tail = val;
				break;
			}
		}
	}

	return { tail };
}

/** Execute the pinch_audit_verify tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { messageStore } = await bootstrapLocal();
	const db = messageStore.getDb();

	// Count total hash-chained entries.
	const countRow = db
		.prepare(
			"SELECT COUNT(*) AS cnt FROM activity_events WHERE entry_hash != ''",
		)
		.get() as { cnt: number };
	const totalEntries = countRow.cnt;

	if (totalEntries === 0) {
		console.log(
			JSON.stringify({
				valid: true,
				total_entries: 0,
				verified_entries: 0,
				genesis_id: null,
				latest_id: null,
			}),
		);
		await shutdownLocal();
		return;
	}

	// Query entries to verify. If --tail N, get the last N; otherwise all.
	let entries: {
		id: string;
		created_at: string;
		actor_pubkey: string;
		action_type: string;
		connection_address: string;
		message_hash: string;
		prev_hash: string;
		entry_hash: string;
	}[];

	if (parsed.tail !== undefined) {
		// Get the last N entries by selecting in reverse, then flipping.
		entries = db
			.prepare(
				`SELECT id, created_at, actor_pubkey, action_type, connection_address,
				        message_hash, prev_hash, entry_hash
				 FROM activity_events
				 WHERE entry_hash != ''
				 ORDER BY created_at DESC, id DESC
				 LIMIT ?`,
			)
			.all(parsed.tail) as typeof entries;
		entries.reverse();
	} else {
		entries = db
			.prepare(
				`SELECT id, created_at, actor_pubkey, action_type, connection_address,
				        message_hash, prev_hash, entry_hash
				 FROM activity_events
				 WHERE entry_hash != ''
				 ORDER BY created_at ASC, id ASC`,
			)
			.all() as typeof entries;
	}

	// Walk the chain and verify.
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];

		// Verify entry hash computation.
		const expectedHash = computeEntryHash({
			id: entry.id,
			timestamp: entry.created_at,
			actorPubkey: entry.actor_pubkey ?? "",
			actionType: entry.action_type ?? "",
			connectionAddress: entry.connection_address,
			messageHash: entry.message_hash ?? "",
			prevHash: entry.prev_hash ?? "",
		});

		if (expectedHash !== entry.entry_hash) {
			console.log(
				JSON.stringify({
					valid: false,
					total_entries: totalEntries,
					first_broken_at: entry.id,
					broken_index: i,
					expected_hash: expectedHash,
					actual_hash: entry.entry_hash,
				}),
			);
			await shutdownLocal();
			return;
		}

		// Verify prev_hash chain linkage.
		if (i === 0 && parsed.tail === undefined) {
			// Genesis entry: prev_hash must be empty.
			if (entry.prev_hash !== "") {
				console.log(
					JSON.stringify({
						valid: false,
						total_entries: totalEntries,
						first_broken_at: entry.id,
						broken_index: i,
						expected_hash: "",
						actual_hash: entry.prev_hash,
					}),
				);
				await shutdownLocal();
				return;
			}
		} else if (i > 0) {
			// Non-genesis: prev_hash must match previous entry's entry_hash.
			const prevEntry = entries[i - 1];
			if (entry.prev_hash !== prevEntry.entry_hash) {
				console.log(
					JSON.stringify({
						valid: false,
						total_entries: totalEntries,
						first_broken_at: entry.id,
						broken_index: i,
						expected_hash: prevEntry.entry_hash,
						actual_hash: entry.prev_hash,
					}),
				);
				await shutdownLocal();
				return;
			}
		}
	}

	console.log(
		JSON.stringify({
			valid: true,
			total_entries: totalEntries,
			verified_entries: entries.length,
			genesis_id: entries[0].id,
			latest_id: entries[entries.length - 1].id,
		}),
	);
	await shutdownLocal();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-audit-verify.ts") ||
		process.argv[1].endsWith("pinch-audit-verify.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
