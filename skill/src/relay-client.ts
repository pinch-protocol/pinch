import WebSocket from "ws";
import sodium from "libsodium-wrappers-sumo";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AuthResponseSchema,
	EnvelopeSchema,
	MessageType,
} from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import type { Envelope } from "@pinch-protocol/proto/pinch/v1/envelope_pb.js";
import type { Keypair } from "./identity.js";
import { ensureSodiumReady } from "./crypto.js";

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
	private authenticated = false;
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
	 * Connect to the relay server. Performs auth handshake before resolving.
	 */
	async connect(): Promise<void> {
		await ensureSodiumReady();
		return new Promise((resolve, reject) => {
			let settled = false;
			const resolveOnce = () => {
				if (settled) {
					return;
				}
				settled = true;
				resolve();
			};
			const rejectOnce = (err: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				reject(err);
			};

			const url = `${this.relayUrl}/ws`;
			this.ws = new WebSocket(url);

			const authTimer = setTimeout(() => {
				this.ws?.terminate();
				rejectOnce(new Error("auth handshake timed out"));
			}, this.authTimeout);

			let authState: "awaiting_challenge" | "awaiting_result" | "done" =
				"awaiting_challenge";

			this.ws.on("open", () => {
				// Wait for auth challenge before considering the client connected.
			});

			this.ws.on("message", (rawData: WebSocket.RawData, isBinary: boolean) => {
				const data = this.normalizeRawData(rawData);

				if (authState === "awaiting_challenge") {
					if (!isBinary) {
						clearTimeout(authTimer);
						this.ws?.close();
						rejectOnce(new Error("expected binary auth challenge"));
						return;
					}
					try {
						this.respondToAuthChallenge(data);
						authState = "awaiting_result";
					} catch (err) {
						clearTimeout(authTimer);
						this.ws?.close();
						rejectOnce(err instanceof Error ? err : new Error(String(err)));
					}
					return;
				}

				if (authState === "awaiting_result") {
					if (!isBinary) {
						clearTimeout(authTimer);
						this.ws?.close();
						rejectOnce(new Error("expected binary auth result"));
						return;
					}
					try {
						const envelope = fromBinary(EnvelopeSchema, new Uint8Array(data));
						if (envelope.payload.case !== "authResult") {
							clearTimeout(authTimer);
							this.ws?.close();
							rejectOnce(
								new Error(`expected AuthResult, got ${envelope.payload.case}`),
							);
							return;
						}
						const result = envelope.payload.value;
						if (!result.success) {
							clearTimeout(authTimer);
							this.ws?.close();
							rejectOnce(
								new Error(
									`auth failed: ${result.errorMessage || "unknown error"}`,
								),
							);
							return;
						}

						this.assignedAddress = result.assignedAddress;
						this.authenticated = true;
						authState = "done";
						clearTimeout(authTimer);

						this.lastPongTime = Date.now();
						this.startHeartbeat();
						resolveOnce();
					} catch (err) {
						clearTimeout(authTimer);
						this.ws?.close();
						rejectOnce(err instanceof Error ? err : new Error(String(err)));
					}
					return;
				}

				if (this.messageHandler) {
					this.messageHandler(data);
				}
				if (this.envelopeHandlers.length > 0) {
					try {
						const env = fromBinary(EnvelopeSchema, new Uint8Array(data));
						for (const handler of this.envelopeHandlers) {
							handler(env);
						}
					} catch {
						// Ignore non-protobuf payloads for envelope handlers.
					}
				}
			});

			this.ws.on("pong", () => {
				this.lastPongTime = Date.now();
			});

			this.ws.on("close", () => {
				clearTimeout(authTimer);
				const wasAuthenticated = this.authenticated;
				this.cleanup();
				if (authState !== "done") {
					rejectOnce(new Error("connection closed during auth handshake"));
				} else if (wasAuthenticated && this.autoReconnect) {
					this.attemptReconnect();
				}
			});

			this.ws.on("error", (err: Error) => {
				clearTimeout(authTimer);
				if (!settled) {
					rejectOnce(err);
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
	 * Returns true if the WebSocket connection is currently open and authenticated.
	 */
	isConnected(): boolean {
		return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
	}

	/**
	 * Register a handler for incoming messages (post-auth only).
	 */
	onMessage(handler: (data: Buffer) => void): void {
		this.messageHandler = handler;
	}

	/**
	 * Register a handler for deserialized protobuf Envelopes (post-auth only).
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
		if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
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

			const timeSinceLastPong = Date.now() - this.lastPongTime;
			if (timeSinceLastPong > this.heartbeatInterval + this.pongTimeout) {
				this.ws.terminate();
				this.cleanup();
				return;
			}

			this.ws.ping();
		}, this.heartbeatInterval);
	}

	/**
	 * Attempt reconnection with exponential backoff and jitter.
	 */
	private async attemptReconnect(): Promise<void> {
		while (this.reconnectAttempt < this.maxAttempts) {
			const delay = Math.min(
				this.baseDelay * 2 ** this.reconnectAttempt + Math.random() * 1000,
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

		if (this.disconnectHandler) {
			this.disconnectHandler();
		}
	}

	/**
	 * Clean up heartbeat timer and reset state.
	 */
	private cleanup(): void {
		this.authenticated = false;
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private normalizeRawData(rawData: WebSocket.RawData): Buffer {
		if (Buffer.isBuffer(rawData)) {
			return rawData;
		}
		if (rawData instanceof Uint8Array) {
			return Buffer.from(rawData);
		}
		if (rawData instanceof ArrayBuffer) {
			return Buffer.from(rawData);
		}
		if (Array.isArray(rawData)) {
			return Buffer.concat(rawData);
		}
		return Buffer.from(rawData as ArrayBuffer);
	}

	private respondToAuthChallenge(data: Uint8Array): void {
		const env = fromBinary(EnvelopeSchema, data);
		if (env.type !== MessageType.AUTH_CHALLENGE || env.payload.case !== "authChallenge") {
			throw new Error("expected auth challenge message");
		}
		const challenge = env.payload.value;
		if (challenge.nonce.length !== 32) {
			throw new Error("invalid auth challenge nonce length");
		}
		if (challenge.relayHost.length === 0) {
			throw new Error("auth challenge missing relay host");
		}
		if (
			this.relayHost.length > 0 &&
			challenge.relayHost.toLowerCase() !== this.relayHost.toLowerCase()
		) {
			throw new Error(
				`auth challenge relay host mismatch: expected ${this.relayHost}, got ${challenge.relayHost}`,
			);
		}

		const signPayload = this.buildSignPayload(challenge.relayHost, challenge.nonce);
		const signature = sodium.crypto_sign_detached(signPayload, this.keypair.privateKey);
		const response = create(EnvelopeSchema, {
			version: 1,
			type: MessageType.AUTH_RESPONSE,
			payload: {
				case: "authResponse",
				value: create(AuthResponseSchema, {
					version: 1,
					publicKey: this.keypair.publicKey,
					signature,
					nonce: challenge.nonce,
				}),
			},
		});
		this.ws?.send(toBinary(EnvelopeSchema, response));
	}

	private buildSignPayload(relayHost: string, nonce: Uint8Array): Uint8Array {
		const prefix = new TextEncoder().encode("pinch-auth-v1");
		const host = new TextEncoder().encode(relayHost);
		const payload = new Uint8Array(prefix.length + 1 + host.length + 1 + nonce.length);
		let offset = 0;
		payload.set(prefix, offset);
		offset += prefix.length;
		payload[offset] = 0;
		offset++;
		payload.set(host, offset);
		offset += host.length;
		payload[offset] = 0;
		offset++;
		payload.set(nonce, offset);
		return payload;
	}
}
