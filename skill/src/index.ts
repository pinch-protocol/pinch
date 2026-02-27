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

// Delivery
export { signDeliveryConfirmation, verifyDeliveryConfirmation } from "./delivery.js";
