/**
 * ActivityFeed records autonomy-related events for human visibility.
 *
 * Backed by the existing MessageStore's SQLite database (same better-sqlite3
 * Database instance). Events include autonomous message processing, circuit
 * breaker trips, and autonomy level changes.
 */

import { v7 as uuidv7 } from "uuid";
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
}

/**
 * ActivityFeed persists autonomy-related events in SQLite.
 *
 * Uses the same better-sqlite3 Database instance as MessageStore.
 * Creates the activity_events table if it does not exist.
 */
export class ActivityFeed {
	constructor(private db: DatabaseType) {
		this.initSchema();
	}

	/**
	 * Create the activity_events table and indexes if they do not exist.
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
	}

	/**
	 * Record an activity event.
	 *
	 * Generates a UUIDv7 id and ISO timestamp automatically.
	 */
	record(
		event: Omit<ActivityEvent, "id" | "createdAt">,
	): ActivityEvent {
		const id = uuidv7();
		const createdAt = new Date().toISOString();

		const stmt = this.db.prepare(`
			INSERT INTO activity_events (
				id, connection_address, event_type, message_id, badge, details, created_at
			) VALUES (
				@id, @connectionAddress, @eventType, @messageId, @badge, @details, @createdAt
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
		});

		return {
			id,
			connectionAddress: event.connectionAddress,
			eventType: event.eventType,
			messageId: event.messageId,
			badge: event.badge,
			details: event.details,
			createdAt,
		};
	}

	/**
	 * Query activity events with optional filters.
	 *
	 * Returns events ordered by createdAt DESC (most recent first).
	 */
	getEvents(opts: {
		connectionAddress?: string;
		eventType?: string;
		limit?: number;
	} = {}): ActivityEvent[] {
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
		};
	}
}
