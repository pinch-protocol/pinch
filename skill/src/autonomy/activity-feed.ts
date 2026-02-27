/**
 * ActivityFeed -- unified event log with SHA-256 hash chaining.
 *
 * Backed by the existing MessageStore's SQLite database (same better-sqlite3
 * Database instance). Records all event types: messages sent/received,
 * connection requests, approvals, rejections, blocks, revokes, autonomy
 * changes, permission updates.
 *
 * Each entry includes a SHA-256 hash chain linking to the previous entry
 * for tamper-evident audit logging (OVRS-05, OVRS-06).
 */

import { v7 as uuidv7 } from "uuid";
import { createHash } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";

/** A single activity event record. */
export interface ActivityEvent {
	id: string;
	connectionAddress: string;
	eventType: string;
	messageId?: string;
	badge?: string;
	details?: string;
	createdAt: string;
	actorPubkey?: string;
	actionType?: string;
	messageHash?: string;
	prevHash?: string;
	entryHash?: string;
}

/**
 * Compute the SHA-256 hash for an activity event entry.
 *
 * The hash covers the entry's own data concatenated with the previous
 * entry's hash, forming a tamper-evident chain. Exported for use by
 * the audit verification tool.
 */
export function computeEntryHash(entry: {
	id: string;
	timestamp: string;
	actorPubkey: string;
	actionType: string;
	connectionAddress: string;
	messageHash: string;
	prevHash: string;
}): string {
	const data = [
		entry.id,
		entry.timestamp,
		entry.actorPubkey,
		entry.actionType,
		entry.connectionAddress,
		entry.messageHash,
		entry.prevHash,
	].join("|");
	return createHash("sha256").update(data).digest("hex");
}

/**
 * ActivityFeed persists events in SQLite with SHA-256 hash chaining.
 *
 * Uses the same better-sqlite3 Database instance as MessageStore.
 * Creates or evolves the activity_events table on construction.
 */
export class ActivityFeed {
	constructor(private db: DatabaseType) {
		this.initSchema();
	}

	/**
	 * Create the activity_events table and indexes if they do not exist.
	 * Evolve the schema with OVRS-06 columns if upgrading from Phase 5.
	 */
	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS activity_events (
				id TEXT PRIMARY KEY,
				connection_address TEXT NOT NULL,
				event_type TEXT NOT NULL,
				message_id TEXT,
				badge TEXT,
				details TEXT,
				created_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_activity_events_connection
				ON activity_events(connection_address, created_at);
			CREATE INDEX IF NOT EXISTS idx_activity_events_type
				ON activity_events(event_type, created_at);
		`);

		// Evolve schema: add Phase 6 columns if they do not exist.
		const columns = this.db
			.prepare("PRAGMA table_info(activity_events)")
			.all() as { name: string }[];
		const columnNames = new Set(columns.map((c) => c.name));

		if (!columnNames.has("actor_pubkey")) {
			this.db.exec(
				"ALTER TABLE activity_events ADD COLUMN actor_pubkey TEXT",
			);
		}
		if (!columnNames.has("action_type")) {
			this.db.exec(
				"ALTER TABLE activity_events ADD COLUMN action_type TEXT",
			);
		}
		if (!columnNames.has("message_hash")) {
			this.db.exec(
				"ALTER TABLE activity_events ADD COLUMN message_hash TEXT",
			);
		}
		if (!columnNames.has("prev_hash")) {
			this.db.exec(
				"ALTER TABLE activity_events ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''",
			);
		}
		if (!columnNames.has("entry_hash")) {
			this.db.exec(
				"ALTER TABLE activity_events ADD COLUMN entry_hash TEXT NOT NULL DEFAULT ''",
			);
		}

		// Time range index for efficient filtering.
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_activity_events_created_range
				ON activity_events(created_at);
		`);
	}

	/**
	 * Record an activity event.
	 *
	 * Generates a UUIDv7 id and ISO timestamp automatically.
	 * Computes SHA-256 hash chain linking to the previous entry.
	 */
	record(
		event: Omit<ActivityEvent, "id" | "createdAt" | "prevHash" | "entryHash">,
	): ActivityEvent {
		const id = uuidv7();
		const createdAt = new Date().toISOString();

		// Get previous entry's hash for chain linking.
		const lastRow = this.db
			.prepare(
				"SELECT entry_hash FROM activity_events ORDER BY created_at DESC, id DESC LIMIT 1",
			)
			.get() as { entry_hash: string } | undefined;
		const prevHash = lastRow?.entry_hash || "";

		// Compute entry hash from data + previous hash.
		const entryHash = computeEntryHash({
			id,
			timestamp: createdAt,
			actorPubkey: event.actorPubkey ?? "",
			actionType: event.actionType ?? event.eventType,
			connectionAddress: event.connectionAddress,
			messageHash: event.messageHash ?? "",
			prevHash,
		});

		const stmt = this.db.prepare(`
			INSERT INTO activity_events (
				id, connection_address, event_type, message_id, badge,
				details, created_at, actor_pubkey, action_type,
				message_hash, prev_hash, entry_hash
			) VALUES (
				@id, @connectionAddress, @eventType, @messageId, @badge,
				@details, @createdAt, @actorPubkey, @actionType,
				@messageHash, @prevHash, @entryHash
			)
		`);

		stmt.run({
			id,
			connectionAddress: event.connectionAddress,
			eventType: event.eventType,
			messageId: event.messageId ?? null,
			badge: event.badge ?? null,
			details: event.details ?? null,
			createdAt,
			actorPubkey: event.actorPubkey ?? null,
			actionType: event.actionType ?? event.eventType,
			messageHash: event.messageHash ?? null,
			prevHash,
			entryHash,
		});

		return {
			id,
			connectionAddress: event.connectionAddress,
			eventType: event.eventType,
			messageId: event.messageId,
			badge: event.badge,
			details: event.details,
			createdAt,
			actorPubkey: event.actorPubkey,
			actionType: event.actionType,
			messageHash: event.messageHash,
			prevHash,
			entryHash,
		};
	}

	/**
	 * Query activity events with optional filters.
	 *
	 * Returns events ordered by createdAt DESC (most recent first).
	 * Supports time range filtering (since/until) and event type exclusion.
	 */
	getEvents(
		opts: {
			connectionAddress?: string;
			eventType?: string;
			since?: string;
			until?: string;
			excludeEventTypes?: string[];
			limit?: number;
		} = {},
	): ActivityEvent[] {
		const conditions: string[] = [];
		const params: Record<string, unknown> = {};

		if (opts.connectionAddress) {
			conditions.push("connection_address = @connectionAddress");
			params.connectionAddress = opts.connectionAddress;
		}
		if (opts.eventType) {
			conditions.push("event_type = @eventType");
			params.eventType = opts.eventType;
		}
		if (opts.since) {
			conditions.push("created_at >= @since");
			params.since = opts.since;
		}
		if (opts.until) {
			conditions.push("created_at <= @until");
			params.until = opts.until;
		}
		if (opts.excludeEventTypes && opts.excludeEventTypes.length > 0) {
			// Use positional placeholders for the IN clause since
			// better-sqlite3 named params don't support arrays.
			const placeholders = opts.excludeEventTypes
				.map((_, i) => `@excludeType${i}`)
				.join(", ");
			conditions.push(`event_type NOT IN (${placeholders})`);
			for (let i = 0; i < opts.excludeEventTypes.length; i++) {
				params[`excludeType${i}`] = opts.excludeEventTypes[i];
			}
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const limit = opts.limit ?? 100;
		params.limit = limit;

		const sql = `
			SELECT * FROM activity_events
			${where}
			ORDER BY created_at DESC
			LIMIT @limit
		`;

		const stmt = this.db.prepare(sql);
		const rows = stmt.all(params) as Record<string, unknown>[];
		return rows.map((row) => this.rowToEvent(row));
	}

	/**
	 * Convert a raw SQLite row to an ActivityEvent.
	 */
	private rowToEvent(row: Record<string, unknown>): ActivityEvent {
		return {
			id: row.id as string,
			connectionAddress: row.connection_address as string,
			eventType: row.event_type as string,
			messageId: (row.message_id as string) ?? undefined,
			badge: (row.badge as string) ?? undefined,
			details: (row.details as string) ?? undefined,
			createdAt: row.created_at as string,
			actorPubkey: (row.actor_pubkey as string) ?? undefined,
			actionType: (row.action_type as string) ?? undefined,
			messageHash: (row.message_hash as string) ?? undefined,
			prevHash: (row.prev_hash as string) ?? undefined,
			entryHash: (row.entry_hash as string) ?? undefined,
		};
	}
}
