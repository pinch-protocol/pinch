/**
 * Shared bootstrap module for all Pinch CLI tools.
 *
 * Reads environment variables, initializes the runtime components
 * (RelayClient, ConnectionStore, MessageStore, ConnectionManager,
 * MessageManager, InboundRouter), connects to the relay, and sets
 * up message handlers.
 *
 * Each tool calls bootstrap() to get all initialized components,
 * performs its operation, then calls shutdown() to clean up.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadKeypair, generateKeypair, saveKeypair } from "../identity.js";
import { RelayClient } from "../relay-client.js";
import { ConnectionStore } from "../connection-store.js";
import { MessageStore } from "../message-store.js";
import { ConnectionManager } from "../connection.js";
import { MessageManager } from "../message-manager.js";
import { InboundRouter } from "../inbound-router.js";
import { ActivityFeed } from "../autonomy/activity-feed.js";
import { PermissionsEnforcer } from "../autonomy/permissions-enforcer.js";
import { NoOpPolicyEvaluator } from "../autonomy/policy-evaluator.js";
import { CircuitBreaker } from "../autonomy/circuit-breaker.js";
import { EnforcementPipeline } from "../autonomy/enforcement-pipeline.js";
import type { Keypair } from "../identity.js";

/** All initialized runtime components returned by bootstrap(). */
export interface BootstrapResult {
	keypair: Keypair;
	relayClient: RelayClient;
	connectionStore: ConnectionStore;
	messageStore: MessageStore;
	connectionManager: ConnectionManager;
	messageManager: MessageManager;
	inboundRouter: InboundRouter;
	activityFeed: ActivityFeed;
	permissionsEnforcer: PermissionsEnforcer;
	circuitBreaker: CircuitBreaker;
	enforcementPipeline: EnforcementPipeline;
}

let bootstrapped: BootstrapResult | null = null;

/**
 * Initialize all runtime components from environment variables.
 *
 * Environment variables:
 * - PINCH_KEYPAIR_PATH: Path to keypair JSON file (default: ~/.pinch/keypair.json)
 * - PINCH_RELAY_URL: WebSocket URL of the relay server (required)
 * - PINCH_RELAY_HOST: Relay hostname for address derivation (default: localhost)
 * - PINCH_DATA_DIR: Directory for SQLite and connection store (default: ~/.pinch/data)
 */
export async function bootstrap(): Promise<BootstrapResult> {
	if (bootstrapped) return bootstrapped;

	const keypairPath =
		process.env.PINCH_KEYPAIR_PATH ??
		join(homedir(), ".pinch", "keypair.json");
	const relayUrl = process.env.PINCH_RELAY_URL;
	if (!relayUrl) {
		throw new Error("PINCH_RELAY_URL environment variable is required");
	}
	const relayHost = process.env.PINCH_RELAY_HOST ?? "localhost";
	const dataDir =
		process.env.PINCH_DATA_DIR ?? join(homedir(), ".pinch", "data");

	// Load or generate keypair.
	let keypair: Keypair;
	try {
		keypair = await loadKeypair(keypairPath);
	} catch {
		keypair = await generateKeypair();
		await saveKeypair(keypair, keypairPath);
	}

	// Create components.
	const relayClient = new RelayClient(relayUrl, keypair, relayHost);
	const connectionStore = new ConnectionStore(
		join(dataDir, "connections.json"),
	);
	await connectionStore.load();
	const messageStore = new MessageStore(join(dataDir, "messages.db"));
	const activityFeed = new ActivityFeed(messageStore.getDb());
	const policyEvaluator = new NoOpPolicyEvaluator();
	const permissionsEnforcer = new PermissionsEnforcer(connectionStore, policyEvaluator);
	const circuitBreaker = new CircuitBreaker(connectionStore, activityFeed);
	const inboundRouter = new InboundRouter(connectionStore, messageStore, activityFeed);
	const enforcementPipeline = new EnforcementPipeline(
		permissionsEnforcer,
		circuitBreaker,
		inboundRouter,
		policyEvaluator,
		connectionStore,
		messageStore,
		activityFeed,
	);
	const connectionManager = new ConnectionManager(
		relayClient,
		connectionStore,
		keypair,
	);
	const messageManager = new MessageManager(
		relayClient,
		connectionStore,
		messageStore,
		keypair,
		enforcementPipeline,
	);

	// Connect to relay and set up handlers.
	await relayClient.connect();
	connectionManager.setupHandlers();
	messageManager.setupHandlers();
	await messageManager.init();

	bootstrapped = {
		keypair,
		relayClient,
		connectionStore,
		messageStore,
		connectionManager,
		messageManager,
		inboundRouter,
		activityFeed,
		permissionsEnforcer,
		circuitBreaker,
		enforcementPipeline,
	};

	return bootstrapped;
}

/**
 * Disconnect from relay and close stores. Call after tool completes.
 */
export async function shutdown(): Promise<void> {
	if (!bootstrapped) return;
	bootstrapped.relayClient.disconnect();
	bootstrapped.messageStore.close();
	bootstrapped = null;
}
