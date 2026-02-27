/**
 * SQLite-backed message persistence for the Pinch agent.
 *
 * Stores all inbound and outbound messages with delivery state tracking,
 * per-connection sequence numbers, pagination, and indexed queries.
 * Uses WAL mode for concurrent read access.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

/** A single persisted message record. */
export interface MessageRecord {
	id: string;
	connectionAddress: string;
	direction: "inbound" | "outbound";
	body: string;
	threadId?: string;
	replyTo?: string;
	priority: "low" | "normal" | "urgent";
	sequence: number;
	state: string;
	failureReason?: string;
	createdAt: string;
	updatedAt: string;
}

/** Options for querying message history. */
export interface HistoryOptions {
	connectionAddress?: string;
	threadId?: string;
	direction?: string;
	state?: string;
	limit?: number;
	offset?: number;
}

/**
 * MessageStore provides SQLite-backed message persistence.
 *
 * Constructor opens (or creates) the SQLite database at the given path,
 * enables WAL mode, and creates the messages and sequences tables
 * if they do not already exist.
 */
export class MessageStore {
	private db: DatabaseType;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.initSchema();
	}

	/**
	 * Expose the underlying SQLite database for shared use (e.g., ActivityFeed).
	 */
	getDb(): DatabaseType {
		return this.db;
	}

	/**
	 * Create tables and indexes if they do not already exist.
	 */
	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				connection_address TEXT NOT NULL,
				direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
				body TEXT NOT NULL,
				thread_id TEXT,
				reply_to TEXT,
				priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'urgent')),
				sequence INTEGER NOT NULL,
				state TEXT NOT NULL,
				failure_reason TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_messages_connection
				ON messages(connection_address, created_at);
			CREATE INDEX IF NOT EXISTS idx_messages_thread
				ON messages(thread_id, created_at);
			CREATE INDEX IF NOT EXISTS idx_messages_state
				ON messages(state);
			CREATE INDEX IF NOT EXISTS idx_messages_direction_state
				ON messages(direction, state);

			CREATE TABLE IF NOT EXISTS sequences (
				connection_address TEXT PRIMARY KEY,
				next_sequence INTEGER NOT NULL DEFAULT 1
			);
		`);
	}

	/**
	 * Persist a message record to the database.
	 */
	saveMessage(msg: MessageRecord): void {
		const stmt = this.db.prepare(`
			INSERT INTO messages (
				id, connection_address, direction, body, thread_id, reply_to,
				priority, sequence, state, failure_reason, created_at, updated_at
			) VALUES (
				@id, @connectionAddress, @direction, @body, @threadId, @replyTo,
				@priority, @sequence, @state, @failureReason, @createdAt, @updatedAt
			)
		`);
		stmt.run({
			id: msg.id,
			connectionAddress: msg.connectionAddress,
			direction: msg.direction,
			body: msg.body,
			threadId: msg.threadId ?? null,
			replyTo: msg.replyTo ?? null,
			priority: msg.priority,
			sequence: msg.sequence,
			state: msg.state,
			failureReason: msg.failureReason ?? null,
			createdAt: msg.createdAt,
			updatedAt: msg.updatedAt,
		});
	}

	/**
	 * Retrieve a single message by ID.
	 */
	getMessage(id: string): MessageRecord | undefined {
		const stmt = this.db.prepare("SELECT * FROM messages WHERE id = ?");
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return this.rowToRecord(row);
	}

	/**
	 * Update the delivery state of a message. Also updates the
	 * updated_at timestamp.
	 */
	updateState(id: string, state: string, failureReason?: string): void {
		const now = new Date().toISOString();
		const stmt = this.db.prepare(`
			UPDATE messages
			SET state = ?, failure_reason = ?, updated_at = ?
			WHERE id = ?
		`);
		stmt.run(state, failureReason ?? null, now, id);
	}

	/**
	 * Query message history with optional filters and pagination.
	 * Returns messages ordered by created_at DESC (most recent first).
	 */
	getHistory(opts: HistoryOptions = {}): MessageRecord[] {
		const conditions: string[] = [];
		const params: Record<string, unknown> = {};

		if (opts.connectionAddress) {
			conditions.push("connection_address = @connectionAddress");
			params.connectionAddress = opts.connectionAddress;
		}
		if (opts.threadId) {
			conditions.push("thread_id = @threadId");
			params.threadId = opts.threadId;
		}
		if (opts.direction) {
			conditions.push("direction = @direction");
			params.direction = opts.direction;
		}
		if (opts.state) {
			conditions.push("state = @state");
			params.state = opts.state;
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const limit = opts.limit ?? 50;
		const offset = opts.offset ?? 0;

		const sql = `
			SELECT * FROM messages
			${where}
			ORDER BY created_at DESC
			LIMIT @limit OFFSET @offset
		`;
		params.limit = limit;
		params.offset = offset;

		const stmt = this.db.prepare(sql);
		const rows = stmt.all(params) as Record<string, unknown>[];
		return rows.map((row) => this.rowToRecord(row));
	}

	/**
	 * Get pending messages by direction.
	 * For outbound: messages with state 'sent' (awaiting confirmation).
	 * For inbound: messages with state 'escalated_to_human' (awaiting human review).
	 */
	getPending(direction: "inbound" | "outbound"): MessageRecord[] {
		const stmt = this.db.prepare(`
			SELECT * FROM messages
			WHERE direction = ? AND state IN ('sent', 'escalated_to_human')
			ORDER BY created_at ASC
		`);
		const rows = stmt.all(direction) as Record<string, unknown>[];
		return rows.map((row) => this.rowToRecord(row));
	}

	/**
	 * Atomically get and increment the sequence number for a connection.
	 * Returns the next sequence number (starting from 1 for new connections).
	 * Uses a transaction to ensure atomic increment.
	 */
	nextSequence(connectionAddress: string): number {
		const insertStmt = this.db.prepare(`
			INSERT OR IGNORE INTO sequences (connection_address, next_sequence)
			VALUES (?, 1)
		`);

		const updateStmt = this.db.prepare(`
			UPDATE sequences
			SET next_sequence = next_sequence + 1
			WHERE connection_address = ?
			RETURNING next_sequence
		`);

		const txn = this.db.transaction((addr: string) => {
			insertStmt.run(addr);
			const row = updateStmt.get(addr) as
				| { next_sequence: number }
				| undefined;
			// The RETURNING clause gives us the value AFTER the increment,
			// so the sequence we should use is (returned value - 1).
			return row ? row.next_sequence - 1 : 1;
		});

		return txn(connectionAddress);
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		this.db.close();
	}

	/**
	 * Convert a raw SQLite row to a MessageRecord, mapping
	 * snake_case column names to camelCase properties.
	 */
	private rowToRecord(row: Record<string, unknown>): MessageRecord {
		return {
			id: row.id as string,
			connectionAddress: row.connection_address as string,
			direction: row.direction as "inbound" | "outbound",
			body: row.body as string,
			threadId: (row.thread_id as string) ?? undefined,
			replyTo: (row.reply_to as string) ?? undefined,
			priority: row.priority as "low" | "normal" | "urgent",
			sequence: row.sequence as number,
			state: row.state as string,
			failureReason: (row.failure_reason as string) ?? undefined,
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
		};
	}
}
