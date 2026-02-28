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

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ActivityFeed } from "../autonomy/activity-feed.js";
import { CircuitBreaker } from "../autonomy/circuit-breaker.js";
import { EnforcementPipeline } from "../autonomy/enforcement-pipeline.js";
import { PermissionsEnforcer } from "../autonomy/permissions-enforcer.js";
import { NoOpPolicyEvaluator } from "../autonomy/policy-evaluator.js";
import { ConnectionStore } from "../connection-store.js";
import { ConnectionManager } from "../connection.js";
import { generateKeypair, loadKeypair, saveKeypair } from "../identity.js";
import type { Keypair } from "../identity.js";
import { InboundRouter } from "../inbound-router.js";
import { MessageManager } from "../message-manager.js";
import { MessageStore } from "../message-store.js";
import { RelayClient } from "../relay-client.js";

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

/** Parse the required `--connection` flag used by connection-management tools. */
export function parseConnectionArg(args: string[]): { connection: string } {
	let connection = "";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--connection") {
			connection = args[++i] ?? "";
			break;
		}
	}

	if (!connection) throw new Error("--connection is required");
	return { connection };
}

/** True when running as the named tool script (ts or built js). */
export function isToolEntrypoint(
	scriptPath: string | undefined,
	toolName: string,
): boolean {
	if (!scriptPath) return false;
	const scriptName = basename(scriptPath);
	return (
		scriptName === toolName ||
		scriptName === `${toolName}.ts` ||
		scriptName === `${toolName}.js` ||
		scriptName === `${toolName}.mjs` ||
		scriptName === `${toolName}.cjs`
	);
}

/** Format safe stderr text for inbound connection notifications. */
export function formatIncomingConnectionRequestLog(
	fromAddress: string,
	message: string,
): string {
	return `[pinch] Incoming connection request ${JSON.stringify({
		fromAddress,
		message,
	})}\n`;
}

/**
 * Run a tool when the current process is executing its script directly.
 * This keeps entrypoint/error boilerplate shared across CLI tools.
 */
export function runToolEntrypoint(
	toolName: string,
	runFn: (args: string[]) => Promise<void>,
): void {
	if (!isToolEntrypoint(process.argv[1], toolName)) return;
	runFn(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}

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
		process.env.PINCH_KEYPAIR_PATH ?? join(homedir(), ".pinch", "keypair.json");
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

	// Safety: clear any stuck passthrough flags from previous session.
	// If the CLI disconnected while passthrough was active, messages would pile up
	// in 'escalated_to_human' state indefinitely. Clearing on bootstrap prevents this.
	await connectionStore.clearPassthroughFlags();

	const messageStore = new MessageStore(join(dataDir, "messages.db"));
	const activityFeed = new ActivityFeed(messageStore.getDb());
	const policyEvaluator = new NoOpPolicyEvaluator();
	const permissionsEnforcer = new PermissionsEnforcer(
		connectionStore,
		policyEvaluator,
	);
	const circuitBreaker = new CircuitBreaker(connectionStore, activityFeed);
	const inboundRouter = new InboundRouter(
		connectionStore,
		messageStore,
		activityFeed,
	);
	const enforcementPipeline = new EnforcementPipeline(
		permissionsEnforcer,
		circuitBreaker,
		inboundRouter,
		policyEvaluator,
		connectionStore,
		messageStore,
		activityFeed,
	);
	const webhookUrl = process.env.PINCH_ON_REQUEST_WEBHOOK;
	const onConnectionRequest = (fromAddress: string, message: string): void => {
		if (webhookUrl) {
			fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ fromAddress, message }),
			}).catch((err) => {
				process.stderr.write(
					`[pinch] Failed to POST connection request webhook: ${err}\n`,
				);
			});
			return;
		}

		process.stderr.write(
			formatIncomingConnectionRequestLog(fromAddress, message),
		);
	};
	const connectionManager = new ConnectionManager(
		relayClient,
		connectionStore,
		keypair,
		onConnectionRequest,
	);
	const messageManager = new MessageManager(
		relayClient,
		connectionStore,
		messageStore,
		keypair,
		enforcementPipeline,
	);

	// Register envelope handlers BEFORE connecting so queued messages
	// flushed by the relay immediately after auth are not dropped.
	connectionManager.setupHandlers();
	messageManager.setupHandlers();

	await relayClient.connect();
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
	await bootstrapped.relayClient.disconnectAsync();
	bootstrapped.messageStore.close();
	bootstrapped = null;
}

// ---------------------------------------------------------------------------
// Local-only bootstrap (no relay connection)
// ---------------------------------------------------------------------------

/** Components returned by bootstrapLocal() -- local stores only, no relay. */
export interface LocalBootstrapResult {
	keypair: Keypair;
	connectionStore: ConnectionStore;
	messageStore: MessageStore;
	activityFeed: ActivityFeed;
}

let localBootstrapped: LocalBootstrapResult | null = null;

/**
 * Initialize only local data stores (keypair, ConnectionStore, MessageStore,
 * ActivityFeed) without connecting to a relay server.
 *
 * Use this for CLI tools that only need to read/write local data and do not
 * require a WebSocket connection to the relay (e.g. pinch-permissions,
 * pinch-audit-verify, pinch-audit-export).
 *
 * Environment variables:
 * - PINCH_KEYPAIR_PATH: Path to keypair JSON file (default: ~/.pinch/keypair.json)
 * - PINCH_DATA_DIR: Directory for SQLite and connection store (default: ~/.pinch/data)
 *
 * Does NOT read or require PINCH_RELAY_URL.
 */
export async function bootstrapLocal(): Promise<LocalBootstrapResult> {
	if (localBootstrapped) return localBootstrapped;

	const keypairPath =
		process.env.PINCH_KEYPAIR_PATH ?? join(homedir(), ".pinch", "keypair.json");
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

	// Create local stores only -- no relay, no managers, no enforcement.
	const connectionStore = new ConnectionStore(
		join(dataDir, "connections.json"),
	);
	await connectionStore.load();
	await connectionStore.clearPassthroughFlags();

	const messageStore = new MessageStore(join(dataDir, "messages.db"));
	const activityFeed = new ActivityFeed(messageStore.getDb());

	localBootstrapped = {
		keypair,
		connectionStore,
		messageStore,
		activityFeed,
	};

	return localBootstrapped;
}

/**
 * Close local stores. Call after local-only tool completes.
 */
export async function shutdownLocal(): Promise<void> {
	if (!localBootstrapped) return;
	localBootstrapped.messageStore.close();
	localBootstrapped = null;
}
