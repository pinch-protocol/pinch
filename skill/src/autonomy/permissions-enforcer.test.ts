import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConnectionStore } from "../connection-store.js";
import { PermissionsEnforcer } from "./permissions-enforcer.js";
import {
	defaultPermissionsManifest,
	type PermissionsManifest,
} from "./permissions-manifest.js";
import type { PolicyEvaluator, PolicyDecision } from "./policy-evaluator.js";

/** Configurable mock PolicyEvaluator for testing. */
class MockPolicyEvaluator implements PolicyEvaluator {
	public boundaryDecision: PolicyDecision = {
		action: "allow",
		confidence: "high",
		reasoning: "Allowed by mock",
	};
	public policyDecision: PolicyDecision = {
		action: "allow",
		confidence: "high",
		reasoning: "Allowed by mock",
	};
	public shouldThrow = false;

	async evaluatePolicy(_params: {
		policy: string;
		messageBody: string;
		senderAddress: string;
		connectionNickname: string;
	}): Promise<PolicyDecision> {
		if (this.shouldThrow) throw new Error("LLM unavailable");
		return this.policyDecision;
	}

	async checkInformationBoundary(_params: {
		boundaries: string[];
		content: string;
	}): Promise<PolicyDecision> {
		if (this.shouldThrow) throw new Error("LLM unavailable");
		return this.boundaryDecision;
	}
}

let tempDir: string;
let store: ConnectionStore;
let mockEvaluator: MockPolicyEvaluator;
let enforcer: PermissionsEnforcer;

const PEER_ADDRESS = "pinch:test123@localhost";

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pinch-enforcer-"));
	store = new ConnectionStore(join(tempDir, "connections.json"));
	await store.load();
	mockEvaluator = new MockPolicyEvaluator();
	enforcer = new PermissionsEnforcer(store, mockEvaluator);
});

describe("PermissionsEnforcer", () => {
	it("denies unknown connection", async () => {
		const result = await enforcer.check("hello", "pinch:unknown@localhost");
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unknown sender");
	});

	it("denies inactive connection", async () => {
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "blocked",
			nickname: "",
			autonomyLevel: "full_manual",
		});

		const result = await enforcer.check("hello", PEER_ADDRESS);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unknown sender");
	});

	it("allows plain text with deny-all manifest and no boundaries", async () => {
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});

		const result = await enforcer.check("hello world", PEER_ADDRESS);
		expect(result.allowed).toBe(true);
	});

	it("denies when information boundary LLM returns deny", async () => {
		const manifest: PermissionsManifest = {
			...defaultPermissionsManifest(),
			informationBoundaries: ["never share financial data"],
		};
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		store.setPermissions(PEER_ADDRESS, manifest);

		mockEvaluator.boundaryDecision = {
			action: "deny",
			confidence: "high",
			reasoning: "Message contains financial data",
		};

		const result = await enforcer.check(
			"My bank balance is $10000",
			PEER_ADDRESS,
		);
		expect(result.allowed).toBe(false);
		expect(result.violationType).toBe("information_boundary");
		expect(result.escalateToHuman).toBeFalsy();
	});

	it("escalates when information boundary LLM returns escalate", async () => {
		const manifest: PermissionsManifest = {
			...defaultPermissionsManifest(),
			informationBoundaries: ["never share financial data"],
		};
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		store.setPermissions(PEER_ADDRESS, manifest);

		mockEvaluator.boundaryDecision = {
			action: "escalate",
			confidence: "low",
			reasoning: "Uncertain if message contains financial data",
		};

		const result = await enforcer.check(
			"I might have some numbers",
			PEER_ADDRESS,
		);
		expect(result.allowed).toBe(false);
		expect(result.violationType).toBe("information_boundary");
		expect(result.escalateToHuman).toBe(true);
	});

	it("allows when information boundary LLM returns allow", async () => {
		const manifest: PermissionsManifest = {
			...defaultPermissionsManifest(),
			informationBoundaries: ["never share financial data"],
		};
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		store.setPermissions(PEER_ADDRESS, manifest);

		mockEvaluator.boundaryDecision = {
			action: "allow",
			confidence: "high",
			reasoning: "No financial data in message",
		};

		const result = await enforcer.check(
			"Let us meet for coffee",
			PEER_ADDRESS,
		);
		expect(result.allowed).toBe(true);
	});

	it("escalates to human on LLM failure (safe default)", async () => {
		const manifest: PermissionsManifest = {
			...defaultPermissionsManifest(),
			informationBoundaries: ["never share financial data"],
		};
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		store.setPermissions(PEER_ADDRESS, manifest);

		mockEvaluator.shouldThrow = true;

		const result = await enforcer.check("any message", PEER_ADDRESS);
		expect(result.allowed).toBe(false);
		expect(result.escalateToHuman).toBe(true);
		expect(result.reason).toContain("Policy evaluation unavailable");
	});

	it("checks custom category with allowed=false triggers boundary check", async () => {
		const manifest: PermissionsManifest = {
			...defaultPermissionsManifest(),
			customCategories: [
				{
					name: "Recruitment",
					description: "Discussing job offers or recruitment",
					allowed: false,
				},
			],
		};
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		store.setPermissions(PEER_ADDRESS, manifest);

		mockEvaluator.boundaryDecision = {
			action: "deny",
			confidence: "high",
			reasoning: "Message discusses job offers",
		};

		const result = await enforcer.check(
			"I have a job opportunity for you",
			PEER_ADDRESS,
		);
		expect(result.allowed).toBe(false);
		expect(result.violationType).toBe("information_boundary");
	});

	it("allows custom category with allowed=true (not checked)", async () => {
		const manifest: PermissionsManifest = {
			...defaultPermissionsManifest(),
			customCategories: [
				{
					name: "Scheduling",
					description: "Discussing meeting schedules",
					allowed: true,
				},
			],
		};
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});
		store.setPermissions(PEER_ADDRESS, manifest);

		// Even with deny decision, allowed categories should not be checked.
		mockEvaluator.boundaryDecision = {
			action: "deny",
			confidence: "high",
			reasoning: "Would deny",
		};

		const result = await enforcer.check(
			"Can we schedule a meeting?",
			PEER_ADDRESS,
		);
		expect(result.allowed).toBe(true);
	});

	it("uses default manifest when connection has no permissionsManifest", async () => {
		// addConnection now assigns a default manifest, but test the path
		// where permissionsManifest might be undefined (e.g., legacy data).
		store.addConnection({
			peerAddress: PEER_ADDRESS,
			peerPublicKey: "AAAA",
			state: "active",
			nickname: "",
			autonomyLevel: "full_manual",
		});

		// The default manifest has no boundaries, so plain text should pass.
		const result = await enforcer.check("hello world", PEER_ADDRESS);
		expect(result.allowed).toBe(true);
	});
});
