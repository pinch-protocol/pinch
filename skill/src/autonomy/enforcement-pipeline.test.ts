import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EnforcementPipeline } from "./enforcement-pipeline.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ActivityFeed } from "./activity-feed.js";
import { ConnectionStore } from "../connection-store.js";
import { MessageStore } from "../message-store.js";
import type { MessageRecord } from "../message-store.js";
import { InboundRouter } from "../inbound-router.js";
import type { PermissionsEnforcer, EnforcementResult } from "./permissions-enforcer.js";
import type { PolicyEvaluator, PolicyDecision } from "./policy-evaluator.js";

/** Mock PermissionsEnforcer that returns configurable results. */
function createMockEnforcer(
	result: EnforcementResult = { allowed: true },
): PermissionsEnforcer {
	return {
		check: async () => result,
	} as unknown as PermissionsEnforcer;
}

/** Mock PolicyEvaluator with configurable decisions. */
function createMockPolicyEvaluator(
	decision?: PolicyDecision,
	shouldThrow = false,
): PolicyEvaluator {
	return {
		async evaluatePolicy() {
			if (shouldThrow) throw new Error("LLM unavailable");
			return decision ?? { action: "escalate", confidence: "low", reasoning: "No LLM" };
		},
		async checkInformationBoundary() {
			return { action: "allow", confidence: "high", reasoning: "OK" };
		},
	} as PolicyEvaluator;
}

/** Create a test message record in the store. */
function createTestMessage(
	store: MessageStore,
	overrides: Partial<MessageRecord> = {},
): MessageRecord {
	const now = new Date().toISOString();
	const msg: MessageRecord = {
		id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		connectionAddress: overrides.connectionAddress ?? "pinch:bob@localhost",
		direction: overrides.direction ?? "inbound",
		body: overrides.body ?? "Test message",
		threadId: overrides.threadId,
		replyTo: overrides.replyTo,
		priority: overrides.priority ?? "normal",
		sequence: overrides.sequence ?? 1,
		state: overrides.state ?? "delivered",
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
	store.saveMessage(msg);
	return msg;
}

const addr = "pinch:bob@localhost";

describe("EnforcementPipeline", () => {
	let tempDir: string;
	let connectionStore: ConnectionStore;
	let messageStore: MessageStore;
	let activityFeed: ActivityFeed;
	let circuitBreaker: CircuitBreaker;
	let inboundRouter: InboundRouter;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pinch-pipeline-test-"));
		connectionStore = new ConnectionStore(
			join(tempDir, "connections.json"),
		);
		await connectionStore.load();
		messageStore = new MessageStore(join(tempDir, "messages.db"));
		activityFeed = new ActivityFeed(messageStore.getDb());
		circuitBreaker = new CircuitBreaker(connectionStore, activityFeed, {
			floodThreshold: 100, // High threshold so it doesn't trip during normal tests
			floodWindowMs: 60_000,
			violationThreshold: 100,
			violationWindowMs: 300_000,
			boundaryProbeThreshold: 100,
			boundaryProbeWindowMs: 600_000,
		});
		inboundRouter = new InboundRouter(
			connectionStore,
			messageStore,
			activityFeed,
		);
	});

	afterEach(() => {
		messageStore.close();
	});

	function makePipeline(
		enforcer?: PermissionsEnforcer,
		policyEval?: PolicyEvaluator,
		cb?: CircuitBreaker,
	): EnforcementPipeline {
		return new EnforcementPipeline(
			enforcer ?? createMockEnforcer(),
			cb ?? circuitBreaker,
			inboundRouter,
			policyEval ?? createMockPolicyEvaluator(),
			connectionStore,
			messageStore,
			activityFeed,
		);
	}

	it("message passes permissions and routes via full_manual -> escalated_to_human", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "full_manual",
		});

		const pipeline = makePipeline();
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("escalated_to_human");
		expect(result.messageId).toBe(msg.id);
	});

	it("message fails permissions -> failed state, violation recorded", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "notify",
		});

		const pipeline = makePipeline(
			createMockEnforcer({
				allowed: false,
				reason: "Information boundary violated",
				violationType: "permission_violation",
			}),
		);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("Information boundary violated");

		// Verify message state was persisted
		const stored = messageStore.getMessage(msg.id);
		expect(stored!.state).toBe("failed");
		expect(stored!.failureReason).toBe("Information boundary violated");
	});

	it("message fails permissions with escalateToHuman -> escalated_to_human state", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "notify",
		});

		const pipeline = makePipeline(
			createMockEnforcer({
				allowed: false,
				reason: "Uncertain boundary match",
				escalateToHuman: true,
			}),
		);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("escalated_to_human");
		expect(result.failureReason).toBe("Uncertain boundary match");
	});

	it("circuit breaker trips during processing -> subsequent routing sees full_manual", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "notify",
		});

		// Use a circuit breaker with threshold of 1 so it trips on first message
		const lowCb = new CircuitBreaker(connectionStore, activityFeed, {
			floodThreshold: 1,
			floodWindowMs: 60_000,
			violationThreshold: 1,
			violationWindowMs: 300_000,
			boundaryProbeThreshold: 1,
			boundaryProbeWindowMs: 600_000,
		});

		const pipeline = makePipeline(undefined, undefined, lowCb);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		// After circuit breaker trips in step 2, the InboundRouter in step 3
		// reads the now-downgraded autonomy level (full_manual)
		expect(result.state).toBe("escalated_to_human");
		expect(lowCb.isTripped(addr)).toBe(true);
		expect(connectionStore.getConnection(addr)!.autonomyLevel).toBe(
			"full_manual",
		);
	});

	it("auto_respond with LLM allow -> read_by_agent", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "auto_respond",
			autoRespondPolicy: "Respond to scheduling requests",
		});

		const pipeline = makePipeline(
			undefined,
			createMockPolicyEvaluator({
				action: "allow",
				confidence: "high",
				reasoning: "Message is a scheduling request",
			}),
		);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("read_by_agent");

		const stored = messageStore.getMessage(msg.id);
		expect(stored!.state).toBe("read_by_agent");
	});

	it("auto_respond with LLM deny -> failed", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "auto_respond",
			autoRespondPolicy: "Only scheduling requests",
		});

		const pipeline = makePipeline(
			undefined,
			createMockPolicyEvaluator({
				action: "deny",
				confidence: "high",
				reasoning: "Message is not a scheduling request",
			}),
		);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe(
			"Message is not a scheduling request",
		);
	});

	it("auto_respond with LLM escalate -> escalated_to_human", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "auto_respond",
			autoRespondPolicy: "Handle normal messages",
		});

		const pipeline = makePipeline(
			undefined,
			createMockPolicyEvaluator({
				action: "escalate",
				confidence: "medium",
				reasoning: "Uncertain about message intent",
			}),
		);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("escalated_to_human");
	});

	it("auto_respond with no policy -> escalated_to_human", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "auto_respond",
			// No autoRespondPolicy set
		});

		const pipeline = makePipeline();
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("escalated_to_human");
	});

	it("auto_respond with LLM error -> escalated_to_human (safe default)", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "auto_respond",
			autoRespondPolicy: "Handle normal messages",
		});

		const pipeline = makePipeline(
			undefined,
			createMockPolicyEvaluator(undefined, true), // throws
		);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("escalated_to_human");
	});

	it("muted connection: message returns state 'delivered', activity feed records muted event, permissions not invoked", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "notify",
			muted: true,
		});

		let permissionsChecked = false;
		const trackingEnforcer = createMockEnforcer();
		const originalCheck = trackingEnforcer.check;
		trackingEnforcer.check = async (...args: Parameters<typeof originalCheck>) => {
			permissionsChecked = true;
			return originalCheck(...args);
		};

		const pipeline = makePipeline(trackingEnforcer);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("delivered");
		expect(result.messageId).toBe(msg.id);
		expect(permissionsChecked).toBe(false);

		const events = activityFeed.getEvents({
			eventType: "message_received_muted",
		});
		expect(events).toHaveLength(1);
		expect(events[0].badge).toBe("muted");
	});

	it("passthrough connection: message returns state 'escalated_to_human', activity feed records intervention event", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "notify",
			passthrough: true,
		});

		const pipeline = makePipeline();
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		expect(result.state).toBe("escalated_to_human");
		expect(result.messageId).toBe(msg.id);

		const events = activityFeed.getEvents({
			eventType: "message_during_intervention",
		});
		expect(events).toHaveLength(1);
		expect(events[0].badge).toBe("intervention");
	});

	it("muted + passthrough: mute takes precedence (mute check is first)", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "notify",
			muted: true,
			passthrough: true,
		});

		const pipeline = makePipeline();
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		const result = await pipeline.process(msg, addr);

		// Mute check comes before passthrough, so muted wins
		expect(result.state).toBe("delivered");
	});

	it("clearPassthroughFlags clears passthrough on all connections", async () => {
		connectionStore.addConnection({
			peerAddress: "pinch:alice@localhost",
			peerPublicKey: "",
			state: "active",
			nickname: "Alice",
			autonomyLevel: "full_manual",
			passthrough: true,
		});
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "full_manual",
			passthrough: true,
		});

		await connectionStore.clearPassthroughFlags();

		expect(connectionStore.getConnection("pinch:alice@localhost")!.passthrough).toBe(false);
		expect(connectionStore.getConnection(addr)!.passthrough).toBe(false);
	});

	it("auto_respond evaluation records activity feed entry with auto_respond_decision details", async () => {
		connectionStore.addConnection({
			peerAddress: addr,
			peerPublicKey: "",
			state: "active",
			nickname: "Bob",
			autonomyLevel: "auto_respond",
			autoRespondPolicy: "Handle scheduling",
		});

		const pipeline = makePipeline(
			undefined,
			createMockPolicyEvaluator({
				action: "allow",
				confidence: "high",
				reasoning: "Scheduling request matched",
			}),
		);
		const msg = createTestMessage(messageStore, {
			connectionAddress: addr,
		});

		await pipeline.process(msg, addr);

		const events = activityFeed.getEvents({
			eventType: "auto_respond_decision",
		});
		expect(events).toHaveLength(1);
		expect(events[0].connectionAddress).toBe(addr);
		expect(events[0].messageId).toBe(msg.id);
		expect(events[0].badge).toBe("auto_respond");

		const details = JSON.parse(events[0].details!);
		expect(details.action).toBe("allow");
		expect(details.confidence).toBe("high");
		expect(details.reasoning).toBe("Scheduling request matched");
	});
});
