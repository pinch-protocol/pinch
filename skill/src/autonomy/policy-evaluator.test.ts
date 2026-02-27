import { describe, expect, it } from "vitest";
import { NoOpPolicyEvaluator } from "./policy-evaluator.js";

describe("NoOpPolicyEvaluator", () => {
	it("evaluatePolicy returns escalate with low confidence", async () => {
		const evaluator = new NoOpPolicyEvaluator();
		const result = await evaluator.evaluatePolicy({
			policy: "Only respond to scheduling requests",
			messageBody: "Can we meet Thursday?",
			senderAddress: "pinch:test@localhost",
			connectionNickname: "Alice",
		});

		expect(result.action).toBe("escalate");
		expect(result.confidence).toBe("low");
		expect(result.reasoning).toContain("No LLM available");
	});

	it("checkInformationBoundary returns escalate with low confidence", async () => {
		const evaluator = new NoOpPolicyEvaluator();
		const result = await evaluator.checkInformationBoundary({
			boundaries: ["never share financial data"],
			content: "My bank account balance is $10,000",
		});

		expect(result.action).toBe("escalate");
		expect(result.confidence).toBe("low");
		expect(result.reasoning).toContain("No LLM available");
	});
});
