/**
 * ConnectionManager orchestrates the full connection lifecycle:
 * request, approve, reject (silent), block (relay-enforced),
 * unblock (reversible), and revoke (notified).
 *
 * All user decisions from CONTEXT.md are honored:
 * - Silent rejection: no response sent on reject
 * - Revoke with notification: other party receives a signal
 * - Block as silent drop: relay enforces, no indication to blocked party
 * - Reversible blocking: unblock restores the connection
 * - New connections default to full_manual
 */

import { create, toBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	ConnectionRequestSchema,
	ConnectionResponseSchema,
	ConnectionRevokeSchema,
	BlockNotificationSchema,
	UnblockNotificationSchema,
	MessageType,
} from "@pinch/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch/proto/pinch/v1/envelope_pb.js";
import type { RelayClient } from "./relay-client.js";
import type { ConnectionStore } from "./connection-store.js";
import type { Keypair } from "./identity.js";

/** Maximum length for connection request messages. */
const MAX_MESSAGE_LENGTH = 280;

/** Default TTL for pending connection requests: 7 days in seconds. */
const REQUEST_TTL_SECONDS = 604800;

/**
 * ConnectionManager manages the lifecycle of peer connections.
 * Constructor takes a RelayClient (for sending/receiving envelopes)
 * and a ConnectionStore (for persisting connection state).
 */
export class ConnectionManager {
	constructor(
		private relayClient: RelayClient,
		private connectionStore: ConnectionStore,
		private keypair?: Keypair,
	) {}

	/**
	 * Send a connection request to another agent.
	 * Creates a pending_outbound connection in the local store.
	 *
	 * @param toAddress - The recipient's pinch: address
	 * @param message - A short introduction message (max 280 chars)
	 * @throws If message exceeds 280 characters or client is not connected
	 */
	async sendRequest(toAddress: string, message: string): Promise<void> {
		if (message.length > MAX_MESSAGE_LENGTH) {
			throw new Error(
				`Message exceeds ${MAX_MESSAGE_LENGTH} character limit`,
			);
		}

		const ownAddress = this.relayClient.assignedAddress;
		if (!ownAddress) {
			throw new Error("Not connected to relay");
		}

		const expiresAt = BigInt(
			Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS,
		);

		// Create ConnectionRequest protobuf.
		const requestEnv = create(EnvelopeSchema, {
			version: 1,
			fromAddress: ownAddress,
			toAddress,
			type: MessageType.CONNECTION_REQUEST,
			payload: {
				case: "connectionRequest",
				value: create(ConnectionRequestSchema, {
					fromAddress: ownAddress,
					toAddress,
					message,
					senderPublicKey: this.keypair?.publicKey ?? new Uint8Array(0),
					expiresAt,
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, requestEnv);
		this.relayClient.sendEnvelope(data);

		// Add to local store as pending_outbound.
		this.connectionStore.addConnection({
			peerAddress: toAddress,
			peerPublicKey: "",
			state: "pending_outbound",
			nickname: "",
			autonomyLevel: "full_manual",
			shortMessage: message,
			expiresAt: new Date(
				(Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS) * 1000,
			).toISOString(),
		});
		await this.connectionStore.save();
	}

	/**
	 * Handle an incoming connection request from another agent.
	 * Stores the request as pending_inbound for human approval.
	 */
	async handleIncomingRequest(envelope: Envelope): Promise<void> {
		if (envelope.payload.case !== "connectionRequest") {
			return;
		}

		const request = envelope.payload.value;
		const senderPubKeyBase64 =
			request.senderPublicKey.length > 0
				? Buffer.from(request.senderPublicKey).toString("base64")
				: "";

		this.connectionStore.addConnection({
			peerAddress: request.fromAddress,
			peerPublicKey: senderPubKeyBase64,
			state: "pending_inbound",
			nickname: "",
			autonomyLevel: "full_manual",
			shortMessage: request.message,
			expiresAt: request.expiresAt
				? new Date(Number(request.expiresAt) * 1000).toISOString()
				: undefined,
		});
		await this.connectionStore.save();
	}

	/**
	 * Approve a pending inbound connection request.
	 * Sends a ConnectionResponse with own public key and marks the
	 * connection as active.
	 */
	async approveRequest(peerAddress: string): Promise<void> {
		const conn = this.connectionStore.getConnection(peerAddress);
		if (!conn) {
			throw new Error(`No connection found for ${peerAddress}`);
		}
		if (conn.state !== "pending_inbound") {
			throw new Error(
				`Cannot approve connection in state: ${conn.state}`,
			);
		}

		const ownAddress = this.relayClient.assignedAddress;
		if (!ownAddress) {
			throw new Error("Not connected to relay");
		}

		// Create ConnectionResponse with acceptance and own public key.
		const responseEnv = create(EnvelopeSchema, {
			version: 1,
			fromAddress: ownAddress,
			toAddress: peerAddress,
			type: MessageType.CONNECTION_RESPONSE,
			payload: {
				case: "connectionResponse",
				value: create(ConnectionResponseSchema, {
					fromAddress: ownAddress,
					toAddress: peerAddress,
					accepted: true,
					responderPublicKey: this.keypair?.publicKey ?? new Uint8Array(0),
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, responseEnv);
		this.relayClient.sendEnvelope(data);

		// Update connection to active. The peer's public key was stored
		// from the incoming request.
		this.connectionStore.updateConnection(peerAddress, {
			state: "active",
		});
		await this.connectionStore.save();
	}

	/**
	 * Reject a pending inbound connection request.
	 * Per locked decision: SILENT REJECTION. No response is sent to the
	 * requester. The sender receives no feedback and cannot infer whether
	 * the recipient exists.
	 */
	async rejectRequest(peerAddress: string): Promise<void> {
		const conn = this.connectionStore.getConnection(peerAddress);
		if (!conn) {
			throw new Error(`No connection found for ${peerAddress}`);
		}
		if (conn.state !== "pending_inbound") {
			throw new Error(
				`Cannot reject connection in state: ${conn.state}`,
			);
		}

		// NO response sent -- silent rejection per CONTEXT.md.
		this.connectionStore.updateConnection(peerAddress, {
			state: "revoked",
		});
		await this.connectionStore.save();
	}

	/**
	 * Handle an incoming connection response (approval or rejection).
	 * If accepted, marks the connection as active and stores the
	 * responder's public key.
	 */
	async handleIncomingResponse(envelope: Envelope): Promise<void> {
		if (envelope.payload.case !== "connectionResponse") {
			return;
		}

		const response = envelope.payload.value;

		if (response.accepted) {
			const responderPubKeyBase64 =
				response.responderPublicKey.length > 0
					? Buffer.from(response.responderPublicKey).toString(
							"base64",
						)
					: "";

			this.connectionStore.updateConnection(response.fromAddress, {
				state: "active",
				peerPublicKey: responderPubKeyBase64 || undefined,
			});
		} else {
			// This should never happen (silent rejection means no response),
			// but handle gracefully.
			this.connectionStore.updateConnection(response.fromAddress, {
				state: "revoked",
			});
		}
		await this.connectionStore.save();
	}

	/**
	 * Block a connection. Updates local state to blocked and sends
	 * a BlockNotification to the relay so it enforces the block
	 * server-side (silent drop).
	 */
	async blockConnection(peerAddress: string): Promise<void> {
		const ownAddress = this.relayClient.assignedAddress;
		if (!ownAddress) {
			throw new Error("Not connected to relay");
		}

		// Update local state.
		this.connectionStore.updateConnection(peerAddress, {
			state: "blocked",
		});

		// Send BlockNotification to relay for server-side enforcement.
		const blockEnv = create(EnvelopeSchema, {
			version: 1,
			fromAddress: ownAddress,
			type: MessageType.BLOCK_NOTIFICATION,
			payload: {
				case: "blockNotification",
				value: create(BlockNotificationSchema, {
					blockerAddress: ownAddress,
					blockedAddress: peerAddress,
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, blockEnv);
		this.relayClient.sendEnvelope(data);
		await this.connectionStore.save();
	}

	/**
	 * Unblock a connection. Per discretion decision: blocking is reversible.
	 * Restores the connection to active and notifies the relay to remove
	 * the block entry.
	 */
	async unblockConnection(peerAddress: string): Promise<void> {
		const ownAddress = this.relayClient.assignedAddress;
		if (!ownAddress) {
			throw new Error("Not connected to relay");
		}

		// Update local state back to active.
		this.connectionStore.updateConnection(peerAddress, {
			state: "active",
		});

		// Send UnblockNotification to relay.
		const unblockEnv = create(EnvelopeSchema, {
			version: 1,
			fromAddress: ownAddress,
			type: MessageType.UNBLOCK_NOTIFICATION,
			payload: {
				case: "unblockNotification",
				value: create(UnblockNotificationSchema, {
					unblockerAddress: ownAddress,
					unblockedAddress: peerAddress,
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, unblockEnv);
		this.relayClient.sendEnvelope(data);
		await this.connectionStore.save();
	}

	/**
	 * Revoke a connection. Per locked decision: revoking sends a
	 * "connection ended" signal to the other party. After revoke,
	 * either party can send a new connection request to reconnect.
	 */
	async revokeConnection(peerAddress: string): Promise<void> {
		const ownAddress = this.relayClient.assignedAddress;
		if (!ownAddress) {
			throw new Error("Not connected to relay");
		}

		// Send ConnectionRevoke to notify the other party.
		const revokeEnv = create(EnvelopeSchema, {
			version: 1,
			fromAddress: ownAddress,
			toAddress: peerAddress,
			type: MessageType.CONNECTION_REVOKE,
			payload: {
				case: "connectionRevoke",
				value: create(ConnectionRevokeSchema, {
					fromAddress: ownAddress,
					toAddress: peerAddress,
				}),
			},
		});

		const data = toBinary(EnvelopeSchema, revokeEnv);
		this.relayClient.sendEnvelope(data);

		// Update local state.
		this.connectionStore.updateConnection(peerAddress, {
			state: "revoked",
		});
		await this.connectionStore.save();
	}

	/**
	 * Handle an incoming connection revoke from the other party.
	 * Updates the connection state to revoked so the agent knows
	 * the connection was terminated (unlike blocking which is silent).
	 */
	async handleIncomingRevoke(envelope: Envelope): Promise<void> {
		if (envelope.payload.case !== "connectionRevoke") {
			return;
		}

		const revoke = envelope.payload.value;
		const conn = this.connectionStore.getConnection(revoke.fromAddress);
		if (conn) {
			this.connectionStore.updateConnection(revoke.fromAddress, {
				state: "revoked",
			});
			await this.connectionStore.save();
		}
	}

	/**
	 * Register envelope handlers on the RelayClient that dispatch
	 * based on MessageType. Sets up the routing for connection
	 * lifecycle messages.
	 */
	setupHandlers(): void {
		this.relayClient.onEnvelope((envelope: Envelope) => {
			switch (envelope.type) {
				case MessageType.CONNECTION_REQUEST:
					this.handleIncomingRequest(envelope);
					break;
				case MessageType.CONNECTION_RESPONSE:
					this.handleIncomingResponse(envelope);
					break;
				case MessageType.CONNECTION_REVOKE:
					this.handleIncomingRevoke(envelope);
					break;
				// Other types: ignore (handled by messaging layer in Phase 3)
			}
		});
	}
}
