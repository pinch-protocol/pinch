/**
 * InboundRouter routes incoming messages based on connection autonomy level.
 *
 * Autonomy levels control how inbound messages are processed:
 * - full_manual: Message state set to "escalated_to_human" (human reviews)
 * - full_auto: Message state set to "read_by_agent" (agent processes directly)
 *
 * State names follow the locked decision in CONTEXT.md:
 * sent, relayed, delivered, read_by_agent, escalated_to_human, failed.
 * The "relayed" state is deferred to Phase 4 when the relay can send acks.
 */

import type { ConnectionStore } from "./connection-store.js";
import type { MessageStore, MessageRecord } from "./message-store.js";

/** Result of routing an inbound message. */
export interface RoutedMessage {
	messageId: string;
	senderAddress: string;
	body: string;
	threadId?: string;
	replyTo?: string;
	priority: "low" | "normal" | "urgent";
	state: string;
	failureReason?: string;
}

/**
 * InboundRouter dispatches inbound messages based on the connection's
 * autonomy level. Unknown senders or inactive connections result in
 * a "failed" state.
 */
export class InboundRouter {
	constructor(
		private connectionStore: ConnectionStore,
		private messageStore: MessageStore,
	) {}

	/**
	 * Route an inbound message based on the connection's autonomy level.
	 *
	 * @param message - The stored message record
	 * @param connectionAddress - The sender's pinch address
	 * @returns The routed message with its assigned state
	 */
	route(message: MessageRecord, connectionAddress: string): RoutedMessage {
		const connection =
			this.connectionStore.getConnection(connectionAddress);

		// Unknown sender or inactive connection -> failed
		if (!connection || connection.state !== "active") {
			const failureReason = "Message from unknown or inactive sender";
			this.messageStore.updateState(
				message.id,
				"failed",
				failureReason,
			);
			return {
				messageId: message.id,
				senderAddress: connectionAddress,
				body: message.body,
				threadId: message.threadId,
				replyTo: message.replyTo,
				priority: message.priority,
				state: "failed",
				failureReason,
			};
		}

		if (connection.autonomyLevel === "full_auto") {
			this.messageStore.updateState(message.id, "read_by_agent");
			return {
				messageId: message.id,
				senderAddress: connectionAddress,
				body: message.body,
				threadId: message.threadId,
				replyTo: message.replyTo,
				priority: message.priority,
				state: "read_by_agent",
			};
		}

		// full_manual or any future unrecognized level -> escalated_to_human
		this.messageStore.updateState(message.id, "escalated_to_human");
		return {
			messageId: message.id,
			senderAddress: connectionAddress,
			body: message.body,
			threadId: message.threadId,
			replyTo: message.replyTo,
			priority: message.priority,
			state: "escalated_to_human",
		};
	}

	/**
	 * Get all messages pending human review (state = "escalated_to_human"),
	 * ordered by created_at ASC (oldest first).
	 * Powers the HEARTBEAT.md checklist.
	 */
	getPendingForReview(): MessageRecord[] {
		return this.messageStore.getHistory({
			state: "escalated_to_human",
			limit: 1000,
		}).reverse(); // getHistory returns DESC, we need ASC
	}

	/**
	 * Approve a message that was escalated to human review.
	 *
	 * @param messageId - The message to approve
	 * @param action - 'agent_handle' transitions to read_by_agent,
	 *                 'human_respond' transitions to delivered
	 * @returns The approved message record
	 */
	approveMessage(
		messageId: string,
		action: "agent_handle" | "human_respond",
	): MessageRecord | undefined {
		const message = this.messageStore.getMessage(messageId);
		if (!message || message.state !== "escalated_to_human") {
			return undefined;
		}

		const newState =
			action === "agent_handle" ? "read_by_agent" : "delivered";
		this.messageStore.updateState(messageId, newState);

		return this.messageStore.getMessage(messageId);
	}
}
