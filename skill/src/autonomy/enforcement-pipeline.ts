/**
 * EnforcementPipeline orchestrates the complete inbound message processing flow.
 *
 * This is the single entry point for processing an inbound message after decryption.
 * Pipeline steps:
 *   1. Permissions check (PermissionsEnforcer)
 *   2. Circuit breaker recording (CircuitBreaker)
 *   3. Autonomy-level routing (InboundRouter)
 *   4. Auto-respond policy evaluation (PolicyEvaluator, if route = pending_policy_eval)
 *
 * Per research pitfall 1 (race condition): the autonomy level is captured at the
 * start of step 3 and used as a snapshot. If the level changes mid-processing,
 * the current message completes under the original level.
 */

import type { PermissionsEnforcer, EnforcementResult } from "./permissions-enforcer.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { InboundRouter, RoutedMessage } from "../inbound-router.js";
import type { PolicyEvaluator } from "./policy-evaluator.js";
import type { ConnectionStore } from "../connection-store.js";
import type { MessageStore, MessageRecord } from "../message-store.js";
import type { ActivityFeed } from "./activity-feed.js";

/**
 * EnforcementPipeline wires permissions -> circuit breaker -> autonomy routing
 * -> policy evaluation into a single process() call.
 */
export class EnforcementPipeline {
	constructor(
		private permissionsEnforcer: PermissionsEnforcer,
		private circuitBreaker: CircuitBreaker,
		private inboundRouter: InboundRouter,
		private policyEvaluator: PolicyEvaluator,
		private connectionStore: ConnectionStore,
		private messageStore: MessageStore,
		private activityFeed: ActivityFeed,
	) {}

	/**
	 * Process an inbound message through the full enforcement pipeline.
	 *
	 * @param message - The stored message record (already decrypted and saved)
	 * @param connectionAddress - The sender's pinch address
	 * @returns The routed message with its final assigned state
	 */
	async process(
		message: MessageRecord,
		connectionAddress: string,
	): Promise<RoutedMessage> {
		// Step 0: Mute check (before everything else -- per pitfall 5, muted
		// messages should skip the entire enforcement pipeline to avoid
		// triggering circuit breakers)
		const connection = this.connectionStore.getConnection(connectionAddress);
		if (connection?.muted) {
			this.activityFeed.record({
				connectionAddress,
				eventType: "message_received_muted",
				messageId: message.id,
				actionType: "message_receive_muted",
				badge: "muted",
			});
			this.messageStore.updateState(message.id, "delivered");
			return {
				messageId: message.id,
				senderAddress: connectionAddress,
				body: message.body,
				threadId: message.threadId,
				replyTo: message.replyTo,
				priority: message.priority,
				state: "delivered",
			};
		}

		// Step 0b: Passthrough check (human intervention mode)
		if (connection?.passthrough) {
			this.messageStore.updateState(message.id, "escalated_to_human");
			this.activityFeed.record({
				connectionAddress,
				eventType: "message_during_intervention",
				messageId: message.id,
				actionType: "message_receive_intervention",
				badge: "intervention",
			});
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

		// Step 1: Permissions check
		const enforcement = await this.permissionsEnforcer.check(
			message.body,
			connectionAddress,
		);

		if (!enforcement.allowed) {
			if (enforcement.escalateToHuman) {
				// Denied but uncertain -- escalate to human for decision
				this.messageStore.updateState(
					message.id,
					"escalated_to_human",
					enforcement.reason,
				);
				return {
					messageId: message.id,
					senderAddress: connectionAddress,
					body: message.body,
					threadId: message.threadId,
					replyTo: message.replyTo,
					priority: message.priority,
					state: "escalated_to_human",
					failureReason: enforcement.reason,
				};
			}

			// Hard deny -- record violation and fail the message
			if (enforcement.violationType) {
				this.circuitBreaker.recordViolation(
					connectionAddress,
					enforcement.violationType as
						| "permission_violation"
						| "spending_exceeded"
						| "boundary_probe",
				);
			}

			this.messageStore.updateState(
				message.id,
				"failed",
				enforcement.reason,
			);
			return {
				messageId: message.id,
				senderAddress: connectionAddress,
				body: message.body,
				threadId: message.threadId,
				replyTo: message.replyTo,
				priority: message.priority,
				state: "failed",
				failureReason: enforcement.reason,
			};
		}

		// Step 2: Circuit breaker recording (flood detection)
		this.circuitBreaker.recordMessage(connectionAddress);

		// Step 3: Autonomy-level routing
		// The InboundRouter reads the current autonomy level from the connection
		// store. If the circuit breaker just downgraded it in step 2, the message
		// will be routed as Full Manual (escalated_to_human).
		const routed = this.inboundRouter.route(message, connectionAddress);

		// Step 4: Auto-respond policy evaluation (if needed)
		if (routed.state === "pending_policy_eval") {
			return this.evaluateAutoRespondPolicy(
				message,
				connectionAddress,
				routed,
			);
		}

		return routed;
	}

	/**
	 * Evaluate the auto-respond policy for a message routed to pending_policy_eval.
	 *
	 * Per research pitfall 5: LLM unavailability -> escalate to human (safe default).
	 * Every evaluation outcome is logged to the activity feed.
	 */
	private async evaluateAutoRespondPolicy(
		message: MessageRecord,
		connectionAddress: string,
		routed: RoutedMessage,
	): Promise<RoutedMessage> {
		const connection =
			this.connectionStore.getConnection(connectionAddress);
		const policy = connection?.autoRespondPolicy;

		// No policy set -> escalate to human (safe default)
		if (!policy) {
			this.messageStore.updateState(message.id, "escalated_to_human");
			this.recordAutoRespondDecision(message.id, connectionAddress, {
				action: "escalate",
				confidence: "low",
				reasoning: "No auto-respond policy configured -- escalating to human",
			});
			return { ...routed, state: "escalated_to_human" };
		}

		try {
			const decision = await this.policyEvaluator.evaluatePolicy({
				policy,
				messageBody: message.body,
				senderAddress: connectionAddress,
				connectionNickname: connection?.nickname ?? "",
			});

			if (decision.action === "allow") {
				this.messageStore.updateState(message.id, "read_by_agent");
				this.recordAutoRespondDecision(
					message.id,
					connectionAddress,
					decision,
				);
				return { ...routed, state: "read_by_agent" };
			}

			if (decision.action === "deny") {
				this.messageStore.updateState(
					message.id,
					"failed",
					decision.reasoning,
				);
				this.recordAutoRespondDecision(
					message.id,
					connectionAddress,
					decision,
				);
				return {
					...routed,
					state: "failed",
					failureReason: decision.reasoning,
				};
			}

			// "escalate" or low confidence -> escalate to human
			this.messageStore.updateState(message.id, "escalated_to_human");
			this.recordAutoRespondDecision(
				message.id,
				connectionAddress,
				decision,
			);
			return { ...routed, state: "escalated_to_human" };
		} catch {
			// LLM unavailable -> safe default: escalate to human
			this.messageStore.updateState(message.id, "escalated_to_human");
			this.recordAutoRespondDecision(message.id, connectionAddress, {
				action: "escalate",
				confidence: "low",
				reasoning: "Policy evaluation error -- escalating to human",
			});
			return { ...routed, state: "escalated_to_human" };
		}
	}

	/**
	 * Record an auto_respond_decision event to the activity feed.
	 * Called after EVERY auto-respond evaluation outcome (allow, deny, escalate, error).
	 */
	private recordAutoRespondDecision(
		messageId: string,
		connectionAddress: string,
		decision: { action: string; confidence: string; reasoning: string },
	): void {
		this.activityFeed.record({
			connectionAddress,
			eventType: "auto_respond_decision",
			messageId,
			badge: "auto_respond",
			details: JSON.stringify({
				action: decision.action,
				confidence: decision.confidence,
				reasoning: decision.reasoning,
			}),
		});
	}
}
