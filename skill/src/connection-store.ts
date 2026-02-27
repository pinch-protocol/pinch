/**
 * JSON-backed connection state persistence for the Pinch agent.
 *
 * Persists all connections with states: active, pending_outbound,
 * pending_inbound, blocked, revoked. Each connection has an autonomy
 * level (full_manual or full_auto) that controls message processing
 * behavior (enforcement deferred to Phase 3+).
 *
 * New connections default to full_manual. Upgrading to full_auto
 * requires explicit confirmation (confirmed: true) -- the data-layer
 * gate for the locked user decision. Confirmation UX deferred to Phase 3.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validateAddress } from "./identity.js";

/** Connection lifecycle states. */
export type ConnectionState =
	| "active"
	| "pending_outbound"
	| "pending_inbound"
	| "blocked"
	| "revoked";

/** Per-connection autonomy level controlling message processing. */
export type AutonomyLevel = "full_manual" | "full_auto";

/** A single connection to a peer agent. */
export interface Connection {
	/** Peer's pinch: address (e.g., pinch:<hash>@<relay>). */
	peerAddress: string;
	/** Base64-encoded Ed25519 public key (empty for pending_outbound until accepted). */
	peerPublicKey: string;
	/** Current connection state. */
	state: ConnectionState;
	/** Local-only user-assigned nickname, default empty string. */
	nickname: string;
	/** Autonomy level for message processing. */
	autonomyLevel: AutonomyLevel;
	/** Free-text message from connection request (max 280 chars). */
	shortMessage?: string;
	/** ISO timestamp when connection was created. */
	createdAt: string;
	/** ISO timestamp of last activity on this connection. */
	lastActivity: string;
	/** ISO timestamp when pending request expires (7-day TTL default). */
	expiresAt?: string;
}

/** Top-level store data format. */
export interface StoreData {
	version: number;
	connections: Record<string, Connection>;
}

/** State priority for sorting (lower = higher priority = shown first). */
const STATE_PRIORITY: Record<ConnectionState, number> = {
	active: 0,
	pending_inbound: 1,
	pending_outbound: 2,
	revoked: 3,
	blocked: 4,
};

/** Maximum short message length in characters. */
const MAX_SHORT_MESSAGE_LENGTH = 280;

/**
 * ConnectionStore persists connections as a JSON file.
 *
 * Call load() before using any read/write methods.
 * Call save() after mutations to persist to disk.
 */
export class ConnectionStore {
	private data: StoreData = { version: 1, connections: {} };

	constructor(private path: string) {}

	/**
	 * Load the store from disk. If the file does not exist,
	 * initializes an empty store.
	 */
	async load(): Promise<void> {
		try {
			const raw = await readFile(this.path, "utf-8");
			this.data = JSON.parse(raw) as StoreData;
		} catch {
			this.data = { version: 1, connections: {} };
		}
	}

	/**
	 * Save the store to disk. Creates the parent directory if needed.
	 */
	async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(this.path, JSON.stringify(this.data, null, 2), "utf-8");
	}

	/**
	 * Get a single connection by peer address.
	 */
	getConnection(peerAddress: string): Connection | undefined {
		return this.data.connections[peerAddress];
	}

	/**
	 * List all connections, optionally filtered by state.
	 * Sorted by state priority (active > pending_inbound > pending_outbound > revoked > blocked),
	 * then by lastActivity descending within each group.
	 */
	listConnections(filter?: { state?: ConnectionState }): Connection[] {
		let connections = Object.values(this.data.connections);

		if (filter?.state) {
			connections = connections.filter((c) => c.state === filter.state);
		}

		return connections.sort((a, b) => {
			const priorityDiff =
				STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
			if (priorityDiff !== 0) return priorityDiff;
			// Within same state, sort by lastActivity descending (most recent first).
			return b.lastActivity.localeCompare(a.lastActivity);
		});
	}

	/**
	 * Add a new connection. Sets createdAt and lastActivity to now.
	 * Enforces default autonomyLevel = "full_manual" and validates
	 * shortMessage length <= 280 chars.
	 * @returns The created Connection.
	 */
	addConnection(
		conn: Omit<Connection, "createdAt" | "lastActivity">,
	): Connection {
		if (
			conn.shortMessage &&
			conn.shortMessage.length > MAX_SHORT_MESSAGE_LENGTH
		) {
			throw new Error(
				`shortMessage exceeds ${MAX_SHORT_MESSAGE_LENGTH} character limit`,
			);
		}

		const now = new Date().toISOString();
		const connection: Connection = {
			...conn,
			// Enforce default autonomy = full_manual per AUTO-02.
			autonomyLevel: conn.autonomyLevel ?? "full_manual",
			createdAt: now,
			lastActivity: now,
		};

		this.data.connections[connection.peerAddress] = connection;
		return connection;
	}

	/**
	 * Update specific fields on an existing connection.
	 * Always updates lastActivity to now.
	 * @throws If the connection does not exist.
	 */
	updateConnection(
		peerAddress: string,
		updates: Partial<
			Pick<
				Connection,
				| "state"
				| "nickname"
				| "autonomyLevel"
				| "peerPublicKey"
				| "lastActivity"
			>
		>,
	): Connection {
		const conn = this.data.connections[peerAddress];
		if (!conn) {
			throw new Error(`connection not found: ${peerAddress}`);
		}

		const now = new Date().toISOString();
		Object.assign(conn, updates, { lastActivity: now });
		return conn;
	}

	/**
	 * Convenience method to set a local-only nickname.
	 */
	setNickname(peerAddress: string, nickname: string): Connection {
		return this.updateConnection(peerAddress, { nickname });
	}

	/**
	 * Change the autonomy level for a connection.
	 *
	 * Per locked decision: downgrading from full_auto to full_manual
	 * takes effect immediately. Upgrading from full_manual to full_auto
	 * REQUIRES opts.confirmed === true -- enforces the data-layer gate.
	 *
	 * The confirmation UX (presenting the warning and collecting approval)
	 * is deferred to Phase 3 skill integration.
	 */
	setAutonomy(
		peerAddress: string,
		level: AutonomyLevel,
		opts?: { confirmed?: boolean },
	): Connection {
		const conn = this.data.connections[peerAddress];
		if (!conn) {
			throw new Error(`connection not found: ${peerAddress}`);
		}

		// Gate: upgrading to full_auto requires explicit confirmation.
		if (
			conn.autonomyLevel === "full_manual" &&
			level === "full_auto" &&
			opts?.confirmed !== true
		) {
			throw new Error(
				"Upgrading to Full Auto requires explicit confirmation",
			);
		}

		return this.updateConnection(peerAddress, { autonomyLevel: level });
	}

	/**
	 * Get the peer's Ed25519 public key as raw bytes.
	 *
	 * Resolution order:
	 * 1. If peerPublicKey is stored and non-empty, decode from base64.
	 * 2. Fall back to extracting from the pinch address using validateAddress()
	 *    (the address embeds the public key in its base58 payload).
	 *
	 * @returns 32-byte Ed25519 public key or null if unavailable.
	 */
	getPeerPublicKey(peerAddress: string): Uint8Array | null {
		const conn = this.data.connections[peerAddress];

		// Try stored base64-encoded key first.
		if (conn?.peerPublicKey && conn.peerPublicKey.length > 0) {
			return Uint8Array.from(Buffer.from(conn.peerPublicKey, "base64"));
		}

		// Fall back to extracting from pinch address.
		try {
			const { pubKey } = validateAddress(peerAddress);
			return pubKey;
		} catch {
			return null;
		}
	}

	/**
	 * Expire pending requests whose expiresAt is in the past.
	 * Marks expired connections as "revoked" (cleaned up).
	 * @returns List of expired peerAddresses.
	 */
	expirePendingRequests(): string[] {
		const now = new Date().toISOString();
		const expired: string[] = [];

		for (const [addr, conn] of Object.entries(this.data.connections)) {
			if (
				(conn.state === "pending_outbound" ||
					conn.state === "pending_inbound") &&
				conn.expiresAt &&
				conn.expiresAt < now
			) {
				conn.state = "revoked";
				conn.lastActivity = now;
				expired.push(addr);
			}
		}

		return expired;
	}
}
