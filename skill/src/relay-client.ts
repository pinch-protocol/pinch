import WebSocket from "ws";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
	EnvelopeSchema,
	AuthChallengeSchema,
	AuthResponseSchema,
	AuthResultSchema,
	MessageType,
} from "@pinch/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch/proto/pinch/v1/envelope_pb.js";
import type { Keypair } from "./identity.js";
import { signChallenge } from "./auth.js";

/** Options for configuring the RelayClient. */
export interface RelayClientOptions {
	/** Heartbeat ping interval in milliseconds. Default: 25000. */
	heartbeatInterval?: number;
	/** Maximum time to wait for a pong response in milliseconds. Default: 7000. */
	pongTimeout?: number;
	/** Maximum time to wait for the auth handshake in milliseconds. Default: 10000. */
	authTimeout?: number;
	/** Enable automatic reconnection with exponential backoff. Default: false. */
	autoReconnect?: boolean;
}

/**
 * RelayClient connects to a Pinch relay server over WebSocket,
 * performs an Ed25519 challenge-response auth handshake, and
 * maintains the connection with periodic heartbeat pings.
 *
 * Phase 2: auth handshake on connect. No reconnection with
 * exponential backoff (not a Phase 2 requirement).
 */
export class RelayClient {
	private ws: WebSocket | null = null;
	private relayUrl: string;
	private keypair: Keypair;
	private relayHost: string;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastPongTime = 0;
	private heartbeatInterval: number;
	private pongTimeout: number;
	private authTimeout: number;
	private messageHandler: ((data: Buffer) => void) | null = null;
	private envelopeHandlers: ((envelope: Envelope) => void)[] = [];

	// Reconnection fields
	private baseDelay = 500;
	private maxDelay = 30_000;
	private maxAttempts = 20;
	private reconnectAttempt = 0;
	private autoReconnect: boolean;
	private disconnectHandler: (() => void) | null = null;

	/** The pinch: address assigned by the relay after successful auth. */
	assignedAddress: string | null = null;

	constructor(
		relayUrl: string,
		keypair: Keypair,
		relayHost: string,
		options?: RelayClientOptions,
	) {
		this.relayUrl = relayUrl;
		this.keypair = keypair;
		this.relayHost = relayHost;
		this.heartbeatInterval = options?.heartbeatInterval ?? 25_000;
		this.pongTimeout = options?.pongTimeout ?? 7_000;
		this.authTimeout = options?.authTimeout ?? 10_000;
		this.autoReconnect = options?.autoReconnect ?? false;
	}

	/**
	 * Connect to the relay server. Performs the Ed25519 challenge-response
	 * auth handshake before resolving. Rejects if connection or auth fails.
	 *
	 * Handshake flow:
	 * 1. Open WebSocket to relay (no ?address= query param)
	 * 2. Receive AuthChallenge (nonce) from relay
	 * 3. Sign nonce with Ed25519 private key
	 * 4. Send AuthResponse (signature + public key)
	 * 5. Receive AuthResult with assigned pinch: address
	 */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const url = `${this.relayUrl}/ws`;
			this.ws = new WebSocket(url);

			// Auth timeout -- reject if handshake takes too long.
			const authTimer = setTimeout(() => {
				if (this.ws) {
					this.ws.terminate();
				}
				reject(new Error("auth handshake timed out"));
			}, this.authTimeout);

			// Track auth state: we wait for exactly two binary messages
			// (AuthChallenge, then AuthResult) before considering connected.
			let authState: "awaiting_challenge" | "awaiting_result" | "done" =
				"awaiting_challenge";

			this.ws.on("open", () => {
				// WebSocket open -- now wait for the relay's AuthChallenge.
				// Do NOT start heartbeat or resolve yet.
			});

			this.ws.on("message", async (data: Buffer) => {
				try {
					if (authState === "awaiting_challenge") {
						// Step 2: Receive AuthChallenge
						const envelope = fromBinary(
							EnvelopeSchema,
							new Uint8Array(data),
						);
						if (envelope.payload.case !== "authChallenge") {
							clearTimeout(authTimer);
							this.ws?.close();
							reject(
								new Error(
									`expected AuthChallenge, got ${envelope.payload.case}`,
								),
							);
							return;
						}

						const nonce = envelope.payload.value.nonce;

						// Step 3: Sign the nonce
						const signature = await signChallenge(
							nonce,
							this.keypair.privateKey,
						);

						// Step 4: Send AuthResponse
						const responseEnv = create(EnvelopeSchema, {
							version: 1,
							type: MessageType.AUTH_RESPONSE,
							payload: {
								case: "authResponse",
								value: create(AuthResponseSchema, {
									signature,
									publicKey: this.keypair.publicKey,
								}),
							},
						});
						const responseData = toBinary(EnvelopeSchema, responseEnv);
						this.ws?.send(responseData);

						authState = "awaiting_result";
					} else if (authState === "awaiting_result") {
						// Step 5: Receive AuthResult
						const envelope = fromBinary(
							EnvelopeSchema,
							new Uint8Array(data),
						);
						if (envelope.payload.case !== "authResult") {
							clearTimeout(authTimer);
							this.ws?.close();
							reject(
								new Error(
									`expected AuthResult, got ${envelope.payload.case}`,
								),
							);
							return;
						}

						const result = envelope.payload.value;
						if (!result.success) {
							clearTimeout(authTimer);
							this.ws?.close();
							reject(
								new Error(
									`auth failed: ${result.errorMessage || "unknown error"}`,
								),
							);
							return;
						}

						// Auth succeeded -- store assigned address.
						this.assignedAddress = result.assignedAddress;
						authState = "done";

						clearTimeout(authTimer);

						// Start heartbeat now that auth is complete.
						this.lastPongTime = Date.now();
						this.startHeartbeat();
						resolve();
					} else {
						// Post-auth messages go to the registered handlers.
						if (this.messageHandler) {
							this.messageHandler(data);
						}
						if (this.envelopeHandlers.length > 0) {
							try {
								const env = fromBinary(
									EnvelopeSchema,
									new Uint8Array(data),
								);
								for (const handler of this.envelopeHandlers) {
									handler(env);
								}
							} catch {
								// Invalid protobuf -- skip envelope handlers.
							}
						}
					}
				} catch (err) {
					clearTimeout(authTimer);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			this.ws.on("pong", () => {
				this.lastPongTime = Date.now();
			});

			this.ws.on("close", () => {
				clearTimeout(authTimer);
				this.cleanup();
				if (authState !== "done") {
					reject(new Error("connection closed during auth handshake"));
				} else if (this.autoReconnect) {
					// Was authenticated and connected, then disconnected --
					// attempt reconnection with exponential backoff.
					this.attemptReconnect();
				}
			});

			this.ws.on("error", (err: Error) => {
				clearTimeout(authTimer);
				// If we haven't connected yet, reject the connect promise.
				if (this.ws?.readyState !== WebSocket.OPEN) {
					reject(err);
				}
			});
		});
	}

	/**
	 * Disconnect from the relay server. Closes the WebSocket cleanly,
	 * stops the heartbeat timer, and disables auto-reconnection.
	 */
	disconnect(): void {
		this.autoReconnect = false;
		if (this.ws) {
			this.ws.close(1000, "client disconnect");
			this.cleanup();
		}
	}

	/**
	 * Register a handler called when the connection is permanently lost
	 * (all reconnection attempts exhausted).
	 */
	onDisconnect(handler: () => void): void {
		this.disconnectHandler = handler;
	}

	/**
	 * Returns true if the WebSocket connection is currently open.
	 */
	isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	/**
	 * Register a handler for incoming messages (post-auth only).
	 */
	onMessage(handler: (data: Buffer) => void): void {
		this.messageHandler = handler;
	}

	/**
	 * Register a handler for deserialized protobuf Envelopes (post-auth only).
	 * Multiple handlers can be registered; all receive the same Envelope.
	 * The handler receives parsed Envelope objects so downstream code
	 * doesn't need to deal with raw bytes.
	 */
	onEnvelope(handler: (envelope: Envelope) => void): void {
		this.envelopeHandlers.push(handler);
	}

	/**
	 * Send a serialized protobuf Envelope over the WebSocket connection.
	 * The connection must be open and authenticated.
	 */
	sendEnvelope(envelope: Uint8Array): void {
		this.send(envelope);
	}

	/**
	 * Wait for the WebSocket connection to be fully open.
	 * Useful in tests when you need to ensure the connection is ready.
	 */
	waitForConnection(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.ws) {
				reject(new Error("not connected"));
				return;
			}
			if (this.ws.readyState === WebSocket.OPEN) {
				resolve();
				return;
			}
			this.ws.once("open", resolve);
			this.ws.once("error", reject);
		});
	}

	/**
	 * Send binary data over the WebSocket connection.
	 * The connection must be open and authenticated.
	 */
	send(data: Uint8Array): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("not connected");
		}
		this.ws.send(data);
	}

	/**
	 * Start the heartbeat loop. Sends a ping at the configured interval
	 * and checks that a pong was received within the pong timeout.
	 */
	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				this.cleanup();
				return;
			}

			// Check if we received a pong since the last ping.
			const timeSinceLastPong = Date.now() - this.lastPongTime;
			if (timeSinceLastPong > this.heartbeatInterval + this.pongTimeout) {
				// No pong received within timeout -- connection is dead.
				this.ws.terminate();
				this.cleanup();
				return;
			}

			this.ws.ping();
		}, this.heartbeatInterval);
	}

	/**
	 * Attempt reconnection with exponential backoff and jitter.
	 * Tries up to maxAttempts times before giving up.
	 */
	private async attemptReconnect(): Promise<void> {
		while (this.reconnectAttempt < this.maxAttempts) {
			const delay = Math.min(
				this.baseDelay * 2 ** this.reconnectAttempt +
					Math.random() * 1000,
				this.maxDelay,
			);
			await new Promise((r) => setTimeout(r, delay));

			try {
				await this.connect();
				this.reconnectAttempt = 0;
				return;
			} catch {
				this.reconnectAttempt++;
			}
		}

		// All attempts exhausted -- notify disconnect handler.
		if (this.disconnectHandler) {
			this.disconnectHandler();
		}
	}

	/**
	 * Clean up heartbeat timer and reset state.
	 */
	private cleanup(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}
}
