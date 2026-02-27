/**
 * PolicyEvaluator interface for LLM-evaluated policy decisions.
 *
 * The actual LLM implementation is injected by the OpenClaw agent runtime.
 * This keeps the skill testable without an LLM. The NoOpPolicyEvaluator
 * provides a safe fallback when no LLM is available (research pitfall 5).
 */

export interface PolicyDecision {
	action: "allow" | "deny" | "escalate";
	confidence: "high" | "medium" | "low";
	reasoning: string;
}

/**
 * PolicyEvaluator is an INTERFACE for LLM-evaluated policy decisions.
 * The actual implementation is injected by the OpenClaw agent runtime.
 * Tests use a mock evaluator.
 */
export interface PolicyEvaluator {
	/**
	 * Evaluate a message against a human-written natural language policy.
	 * Used for Auto-respond autonomy level.
	 */
	evaluatePolicy(params: {
		policy: string;
		messageBody: string;
		senderAddress: string;
		connectionNickname: string;
	}): Promise<PolicyDecision>;

	/**
	 * Check whether content violates information boundaries.
	 * Used for any autonomy level when boundaries are configured.
	 * Per locked decision: uncertain outcomes -> block + escalate to human.
	 */
	checkInformationBoundary(params: {
		boundaries: string[];
		content: string;
	}): Promise<PolicyDecision>;
}

/**
 * NoOpPolicyEvaluator is the safe fallback when no LLM is available.
 *
 * Per research pitfall 5 (LLM unavailability): all evaluations return
 * 'escalate' with low confidence, ensuring messages are blocked and
 * escalated to the human for review.
 */
export class NoOpPolicyEvaluator implements PolicyEvaluator {
	async evaluatePolicy(_params: {
		policy: string;
		messageBody: string;
		senderAddress: string;
		connectionNickname: string;
	}): Promise<PolicyDecision> {
		return {
			action: "escalate",
			confidence: "low",
			reasoning: "No LLM available -- escalating to human",
		};
	}

	async checkInformationBoundary(_params: {
		boundaries: string[];
		content: string;
	}): Promise<PolicyDecision> {
		return {
			action: "escalate",
			confidence: "low",
			reasoning: "No LLM available -- escalating to human",
		};
	}
}
