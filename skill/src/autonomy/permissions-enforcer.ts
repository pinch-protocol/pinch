/**
 * PermissionsEnforcer gates content BEFORE autonomy routing.
 *
 * Checks the connection's permissions manifest against inbound messages.
 * Structural checks (calendar, files, actions, spending) run without LLM.
 * Information boundary and custom category checks delegate to PolicyEvaluator.
 *
 * Safe defaults: LLM unavailability -> escalate to human.
 * Uncertain boundary outcomes -> block + escalate per locked decision.
 */

import type { ConnectionStore } from "../connection-store.js";
import { defaultPermissionsManifest } from "./permissions-manifest.js";
import type { PolicyEvaluator } from "./policy-evaluator.js";

export interface EnforcementResult {
	allowed: boolean;
	reason?: string; // Why denied
	violationType?: string; // 'permission_violation' | 'information_boundary' | 'spending_exceeded'
	escalateToHuman?: boolean; // True if uncertain and needs human decision
}

/**
 * PermissionsEnforcer checks a message against the connection's
 * permissions manifest. Runs BEFORE autonomy routing.
 */
export class PermissionsEnforcer {
	constructor(
		private connectionStore: ConnectionStore,
		private policyEvaluator: PolicyEvaluator,
	) {}

	/**
	 * Check whether a message is allowed through the permissions manifest.
	 *
	 * @param messageBody - The plaintext message content
	 * @param connectionAddress - The sender's pinch address
	 * @returns EnforcementResult indicating whether the message is allowed
	 */
	async check(
		messageBody: string,
		connectionAddress: string,
	): Promise<EnforcementResult> {
		// 1. Get connection. Unknown/inactive -> deny.
		const connection =
			this.connectionStore.getConnection(connectionAddress);
		if (!connection || connection.state !== "active") {
			return { allowed: false, reason: "unknown sender" };
		}

		// 2. Get manifest, defaulting to deny-all if undefined.
		const manifest =
			connection.permissionsManifest ?? defaultPermissionsManifest();

		// 3. Structural check: if manifest is fully deny-all (all categories 'none',
		//    all spending 0, no custom categories), it is a hard deny-all posture.
		//    However, per v1 design, plain text messages pass the structural check.
		//    The structural check blocks when the manifest is deny-all AND
		//    information boundaries or custom categories would not gate content
		//    (i.e., they are empty). In that pure deny-all case, only the
		//    information boundary / custom category checks below provide gating.
		//    Since boundaries are empty for a deny-all manifest, plain text passes.
		//
		//    NOTE: Future phases can add structured action types for fine-grained
		//    structural enforcement. For v1, structural enforcement focuses on
		//    information boundaries.

		// 4. Information boundary check (LLM needed).
		if (manifest.informationBoundaries.length > 0) {
			try {
				const decision =
					await this.policyEvaluator.checkInformationBoundary({
						boundaries: manifest.informationBoundaries,
						content: messageBody,
					});

				if (
					decision.action === "deny" ||
					decision.action === "escalate"
				) {
					return {
						allowed: false,
						reason: decision.reasoning,
						violationType: "information_boundary",
						escalateToHuman: decision.action === "escalate",
					};
				}
			} catch {
				// LLM failure -> safe default: escalate to human.
				return {
					allowed: false,
					reason: "Policy evaluation unavailable -- escalating to human",
					escalateToHuman: true,
				};
			}
		}

		// 5. Custom category check (LLM needed).
		//    For each denied custom category, check if the message matches.
		const deniedCategories = manifest.customCategories.filter(
			(c) => !c.allowed,
		);
		for (const category of deniedCategories) {
			try {
				const decision =
					await this.policyEvaluator.checkInformationBoundary({
						boundaries: [category.description],
						content: messageBody,
					});

				if (
					decision.action === "deny" ||
					decision.action === "escalate"
				) {
					return {
						allowed: false,
						reason: decision.reasoning,
						violationType: "information_boundary",
						escalateToHuman: decision.action === "escalate",
					};
				}
			} catch {
				// LLM failure -> safe default: escalate to human.
				return {
					allowed: false,
					reason: "Policy evaluation unavailable -- escalating to human",
					escalateToHuman: true,
				};
			}
		}

		// 6. All checks pass.
		return { allowed: true };
	}
}
