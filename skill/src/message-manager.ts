/**
 * MessageManager orchestrates encrypted message send/receive/confirm flows.
 *
 * Composes crypto primitives (NaCl box encrypt/decrypt), message store (SQLite),
 * delivery signing (Ed25519 detached signatures), relay transport, and inbound
 * routing to implement the full Pinch encrypted messaging protocol.
 *
 * All messages are encrypted end-to-end: the relay never sees plaintext content.
 * Delivery confirmations are signed by the recipient, proving delivery to the
 * actual intended party (not forged by the relay or a third party).
 */

import { v7 as uuidv7 } from "uuid";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	EncryptedPayloadSchema,
	PlaintextPayloadSchema,
	DeliveryConfirmSchema,
	MessageType,
} from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import { ensureSodiumReady, encrypt, decrypt, ed25519PubToX25519, ed25519PrivToX25519 } from "./crypto.js";
import { signDeliveryConfirmation, verifyDeliveryConfirmation } from "./delivery.js";
import type { RelayClient } from "./relay-client.js";
import type { ConnectionStore } from "./connection-store.js";
import type { MessageStore, MessageRecord } from "./message-store.js";
import type { Keypair } from "./identity.js";
import type { EnforcementPipeline } from "./autonomy/enforcement-pipeline.js";

/** Maximum serialized envelope size (conservative limit below relay's 64KB). */
const MAX_ENVELOPE_SIZE = 60 * 1024;

/** Parameters for sending a message. */
export interface SendMessageParams {
	recipient: string;
	body: string;
	threadId?: string;
	replyTo?: string;
	priority?: "low" | "normal" | "urgent";
	attribution?: "agent" | "human";
}

/**
 * MessageManager coordinates all message operations: encrypt, send, receive,
 * decrypt, and delivery confirmation flows.
 */
export class MessageManager {
	private _flushRemaining = -1; // -1 = no QueueStatus received yet
	private _flushResolve: (() => void) | null = null;
	private _flushPromise: Promise<void> | null = null;
	private _queueStatusReceived = false;

	constructor(
		private relayClient: RelayClient,
		private connectionStore: ConnectionStore,
		private messageStore: MessageStore,
		private keypair: Keypair,
		private enforcementPipeline: EnforcementPipeline,
	) {}

	/**
	 * Returns a promise that resolves once all relay-queued messages
	 * (reported via QueueStatus) have been received and stored.
	 *
	 * Waits briefly for a QueueStatus to arrive after auth. If none
	 * arrives within the grace period, assumes no messages are queued.
	 */
	async waitForFlush(timeoutMs = 10_000): Promise<void> {
		// Give the relay a moment to send QueueStatus after auth.
		// The relay sends it immediately after registration in the hub,
		// so a short grace period is sufficient.
		if (!this._queueStatusReceived) {
			await new Promise<void>((resolve) => {
				const check = () => {
					if (this._queueStatusReceived) { resolve(); return; }
					elapsed += 50;
					if (elapsed >= 2000) { resolve(); return; }
					setTimeout(check, 50);
				};
				let elapsed = 0;
				setTimeout(check, 50);
			});
		}

		// No queued messages (or none reported).
		if (this._flushRemaining <= 0) return;

		if (this._flushPromise) return this._flushPromise;

this._flushPromise = new Promise<void>((resolve, reject) => {
	this._flushResolve = resolve;
	setTimeout(() => {
		this._flushResolve = null;
		this._flushPromise = null;
		this._flushRemaining = 0;
		reject(new Error(`waitForFlush timed out after ${timeoutMs}ms`));
	}, timeoutMs);
});
		return this._flushPromise;
	}

	/**
	 * Initialize crypto subsystem. Must be called before any message operations.
	 */
	async init(): Promise<void> {
		await ensureSodiumReady();
	}

	/**
	 * Encrypt and send a message to a connected peer.
	 *
	 * @returns The UUIDv7 message ID
	 * @throws If the connection is not active or peer public key is unavailable
	 */
	async sendMessage(params: SendMessageParams): Promise<string> {
		const { recipient, body, replyTo, priority = "normal" } = params;

		// 1. Validate connection is active
		const connection = this.connectionStore.getConnection(recipient);
		if (!connection || connection.state !== "active") {
			throw new Error("Connection is not active");
		}

		// 2. Get peer's Ed25519 public key
		const peerEd25519Pub = this.connectionStore.getPeerPublicKey(recipient);
		if (!peerEd25519Pub) {
			throw new Error("Peer public key not available");
		}

		// 3. Generate messageId
		const messageId = uuidv7();

		// 4. Resolve threadId
		let threadId = params.threadId;
		if (!threadId && replyTo) {
			const replyMsg = this.messageStore.getMessage(replyTo);
			if (replyMsg?.threadId) {
				threadId = replyMsg.threadId;
			}
		}
		if (!threadId) {
			threadId = messageId;
		}

		// 5. Get next sequence number
		const sequence = this.messageStore.nextSequence(recipient);

		// 6-7. Build and serialize PlaintextPayload with attribution wrapper
		const attribution = params.attribution ?? "agent";
		const wrappedContent = JSON.stringify({
			text: body,
			attribution,
		});
		const plaintext = create(PlaintextPayloadSchema, {
			version: 1,
			sequence: BigInt(sequence),
			timestamp: BigInt(Date.now()),
			content: new TextEncoder().encode(wrappedContent),
			contentType: "application/x-pinch+json",
		});
		const plaintextBytes = toBinary(PlaintextPayloadSchema, plaintext);

		// 8. Convert keys for NaCl box
		const senderX25519Priv = ed25519PrivToX25519(this.keypair.privateKey);
		const recipientX25519Pub = ed25519PubToX25519(peerEd25519Pub);

		// 9. Encrypt
		const sealed = encrypt(plaintextBytes, recipientX25519Pub, senderX25519Priv);

		// 10. Split nonce and ciphertext
		const nonce = sealed.slice(0, 24);
		const ciphertext = sealed.slice(24);

		// 11. Build Envelope
		const fromAddress = this.relayClient.assignedAddress;
		if (!fromAddress) {
			throw new Error("Not connected to relay");
		}

		const envelope = create(EnvelopeSchema, {
			version: 1,
			fromAddress,
			toAddress: recipient,
			type: MessageType.MESSAGE,
			messageId: new TextEncoder().encode(messageId),
			timestamp: BigInt(Date.now()),
			payload: {
				case: "encrypted",
				value: create(EncryptedPayloadSchema, {
					nonce,
					ciphertext,
					senderPublicKey: this.keypair.publicKey,
				}),
			},
		});

		// 12. Size check
		const envelopeBytes = toBinary(EnvelopeSchema, envelope);
		if (envelopeBytes.length > MAX_ENVELOPE_SIZE) {
			throw new Error("message too large");
		}

		// 13. Save outbound message
		const now = new Date().toISOString();
		this.messageStore.saveMessage({
			id: messageId,
			connectionAddress: recipient,
			direction: "outbound",
			body,
			threadId,
			replyTo,
			priority,
			sequence,
			state: "sent",
			attribution: params.attribution ?? "agent",
			createdAt: now,
			updatedAt: now,
		});

		// 14. Send via relay
		this.relayClient.sendEnvelope(envelopeBytes);

		// 15. Return messageId
		return messageId;
	}

	/**
	 * Handle an incoming encrypted message from a peer.
	 * Decrypts the message, stores it, routes via InboundRouter,
	 * and sends a delivery confirmation back to the sender.
	 */
	async handleIncomingMessage(envelope: Envelope): Promise<void> {
		// 1. Extract EncryptedPayload
		if (envelope.payload.case !== "encrypted") {
			throw new Error("Expected encrypted payload");
		}
		const encryptedPayload = envelope.payload.value;

		// 2. Get sender address
		const senderAddress = envelope.fromAddress;

		// 3. Get sender's Ed25519 public key from the encrypted payload
		const senderEd25519Pub = encryptedPayload.senderPublicKey;

		// 4. Convert keys
		const senderX25519Pub = ed25519PubToX25519(senderEd25519Pub);
		const recipientX25519Priv = ed25519PrivToX25519(this.keypair.privateKey);

		// 5. Reconstruct sealed message
		const sealed = new Uint8Array(encryptedPayload.nonce.length + encryptedPayload.ciphertext.length);
		sealed.set(encryptedPayload.nonce);
		sealed.set(encryptedPayload.ciphertext, encryptedPayload.nonce.length);

		// 6. Decrypt
		const decryptedBytes = decrypt(sealed, senderX25519Pub, recipientX25519Priv);

		// 7. Deserialize PlaintextPayload
		const plaintextPayload = fromBinary(PlaintextPayloadSchema, decryptedBytes);

		// 8. Extract text body with attribution detection
		const rawBody = new TextDecoder().decode(plaintextPayload.content);
		let body = rawBody;
		let inboundAttribution: "agent" | "human" = "agent";
		if (plaintextPayload.contentType === "application/x-pinch+json") {
			try {
				const parsed = JSON.parse(rawBody);
				body = parsed.text ?? rawBody;
				inboundAttribution = parsed.attribution ?? "agent";
			} catch {
				// Not valid JSON -- use raw body
				body = rawBody;
			}
		}

		// 9. Derive messageId
		const messageId = new TextDecoder().decode(envelope.messageId);

		// 10. Store inbound message
		const now = new Date().toISOString();
		const messageRecord: MessageRecord = {
			id: messageId,
			connectionAddress: senderAddress,
			direction: "inbound",
			body,
			sequence: Number(plaintextPayload.sequence),
			state: "delivered",
			priority: "normal",
			attribution: inboundAttribution,
			createdAt: now,
			updatedAt: now,
		};
		this.messageStore.saveMessage(messageRecord);

		// 11. Route via EnforcementPipeline
		await this.enforcementPipeline.process(messageRecord, senderAddress);

		// 12. Send delivery confirmation
		await this.sendDeliveryConfirmation(messageId, senderAddress);

		// 13. Track flush progress
		if (this._flushRemaining > 0) {
			this._flushRemaining--;
			if (this._flushRemaining <= 0 && this._flushResolve) {
				this._flushResolve();
				this._flushResolve = null;
				this._flushPromise = null;
			}
		}
	}

	/**
	 * Send a signed delivery confirmation back to the original sender.
	 */
	private async sendDeliveryConfirmation(
		messageId: string,
		senderAddress: string,
	): Promise<void> {
		const messageIdBytes = new TextEncoder().encode(messageId);
		const timestamp = BigInt(Date.now());

		// 1. Sign delivery confirmation
		const signature = await signDeliveryConfirmation(
			messageIdBytes,
			timestamp,
			this.keypair.privateKey,
		);

		// 2. Build DeliveryConfirm payload
		const deliveryConfirm = create(DeliveryConfirmSchema, {
			messageId: messageIdBytes,
			signature,
			timestamp,
			state: "delivered",
		});

		// 3. Wrap in Envelope
		const fromAddress = this.relayClient.assignedAddress;
		if (!fromAddress) return;

		const envelope = create(EnvelopeSchema, {
			version: 1,
			fromAddress,
			toAddress: senderAddress,
			type: MessageType.DELIVERY_CONFIRM,
			timestamp,
			payload: {
				case: "deliveryConfirm",
				value: deliveryConfirm,
			},
		});

		// 4. Send
		const envelopeBytes = toBinary(EnvelopeSchema, envelope);
		this.relayClient.sendEnvelope(envelopeBytes);
	}

	/**
	 * Handle a delivery confirmation from the recipient of a message we sent.
	 * Verifies the Ed25519 signature and updates the message state.
	 */
	async handleDeliveryConfirmation(envelope: Envelope): Promise<void> {
		// 1. Extract DeliveryConfirm
		if (envelope.payload.case !== "deliveryConfirm") {
			throw new Error("Expected deliveryConfirm payload");
		}
		const confirm = envelope.payload.value;

		// 2. Get messageId
		const messageId = new TextDecoder().decode(confirm.messageId);

		// 3. Look up original message
		const message = this.messageStore.getMessage(messageId);
		if (!message) return;

		// 4. Get sender's Ed25519 public key
		const peerPubKey = this.connectionStore.getPeerPublicKey(
			envelope.fromAddress,
		);
		if (!peerPubKey) return;

		// 5. Verify signature
		const valid = await verifyDeliveryConfirmation(
			confirm.signature,
			confirm.messageId,
			confirm.timestamp,
			peerPubKey,
		);

		// 6-7. Update state or log warning
		if (valid) {
			this.messageStore.updateState(messageId, confirm.state);
			if (confirm.wasStored) {
				console.log(`Delivery confirmed for ${messageId} (stored: true)`);
			}
		} else {
			console.warn(
				`Invalid delivery confirmation signature for message ${messageId}`,
			);
		}
	}

	/**
	 * Register envelope handlers on the RelayClient that dispatch
	 * MESSAGE and DELIVERY_CONFIRM types to the appropriate methods.
	 *
	 * This coexists with ConnectionManager's setupHandlers because
	 * RelayClient supports multiple onEnvelope handlers.
	 */
	setupHandlers(): void {
		this.relayClient.onEnvelope((envelope: Envelope) => {
			switch (envelope.type) {
				case MessageType.MESSAGE:
					this.handleIncomingMessage(envelope);
					break;
				case MessageType.DELIVERY_CONFIRM:
					this.handleDeliveryConfirmation(envelope);
					break;
				case MessageType.QUEUE_STATUS:
					this.handleQueueStatus(envelope);
					break;
				case MessageType.QUEUE_FULL:
					this.handleQueueFull(envelope);
					break;
				case MessageType.RATE_LIMITED:
					this.handleRateLimited(envelope);
					break;
			}
		});
	}

	/**
	 * Handle a QueueStatus envelope from the relay indicating pending
	 * queued messages before a flush begins.
	 */
	private handleQueueStatus(envelope: Envelope): void {
		if (envelope.payload.case !== "queueStatus") return;
		const pendingCount = envelope.payload.value.pendingCount;
		this._flushRemaining = pendingCount;
		this._queueStatusReceived = true;
		console.log(`Relay reports ${pendingCount} queued messages pending flush`);
	}

	/**
	 * Handle a RateLimited envelope from the relay indicating the sender
	 * has exceeded the per-connection rate limit.
	 */
	private handleRateLimited(envelope: Envelope): void {
		if (envelope.payload.case !== "rateLimited") return;
		const { retryAfterMs, reason } = envelope.payload.value;
		console.warn(
			`Rate limited by relay: ${reason}. Retry after ${retryAfterMs}ms`,
		);
	}

	/**
	 * Handle a QueueFull envelope from the relay indicating the recipient's
	 * message queue has reached capacity.
	 */
	private handleQueueFull(envelope: Envelope): void {
		if (envelope.payload.case !== "queueFull") return;
		const { recipientAddress, reason } = envelope.payload.value;
		console.warn(`Message to ${recipientAddress} not queued: ${reason}`);
	}
}
