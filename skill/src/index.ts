export const VERSION = "0.1.0";

// Core identity and crypto
export { generateKeypair, loadKeypair, saveKeypair, generateAddress, validateAddress } from "./identity.js";
export type { Keypair } from "./identity.js";
export { ensureSodiumReady, encrypt, decrypt, ed25519PubToX25519, ed25519PrivToX25519 } from "./crypto.js";

// Transport
export { RelayClient } from "./relay-client.js";
export type { RelayClientOptions } from "./relay-client.js";

// Connection management
export { ConnectionStore } from "./connection-store.js";
export type { Connection, ConnectionState, AutonomyLevel } from "./connection-store.js";
export { ConnectionManager } from "./connection.js";

// Message management
export { MessageStore } from "./message-store.js";
export type { MessageRecord, HistoryOptions } from "./message-store.js";
export { MessageManager } from "./message-manager.js";
export type { SendMessageParams } from "./message-manager.js";

// Inbound routing
export { InboundRouter } from "./inbound-router.js";
export type { RoutedMessage } from "./inbound-router.js";

// Autonomy
export { ActivityFeed, computeEntryHash } from "./autonomy/activity-feed.js";
export type { ActivityEvent } from "./autonomy/activity-feed.js";
export { defaultPermissionsManifest, validateManifest } from "./autonomy/permissions-manifest.js";
export type { PermissionsManifest, CalendarPermission, FilePermission, ActionPermission, SpendingCaps, CustomCategory } from "./autonomy/permissions-manifest.js";
export { PermissionsEnforcer } from "./autonomy/permissions-enforcer.js";
export type { EnforcementResult } from "./autonomy/permissions-enforcer.js";
export { NoOpPolicyEvaluator } from "./autonomy/policy-evaluator.js";
export type { PolicyEvaluator, PolicyDecision } from "./autonomy/policy-evaluator.js";
export { CircuitBreaker } from "./autonomy/circuit-breaker.js";
export type { CircuitBreakerConfig, TriggerType } from "./autonomy/circuit-breaker.js";
export { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./autonomy/circuit-breaker.js";
export { EnforcementPipeline } from "./autonomy/enforcement-pipeline.js";

// Delivery
export { signDeliveryConfirmation, verifyDeliveryConfirmation } from "./delivery.js";
