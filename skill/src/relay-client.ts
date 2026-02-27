import WebSocket from "ws";

/** Options for configuring the RelayClient. */
export interface RelayClientOptions {
	/** Heartbeat ping interval in milliseconds. Default: 25000. */
	heartbeatInterval?: number;
	/** Maximum time to wait for a pong response in milliseconds. Default: 7000. */
	pongTimeout?: number;
}

/**
 * RelayClient connects to a Pinch relay server over WebSocket and
 * maintains the connection with periodic heartbeat pings.
 *
 * Phase 1: simple connect/disconnect with heartbeat. No reconnection
 * with exponential backoff (not a Phase 1 requirement).
 */
export class RelayClient {
	private ws: WebSocket | null = null;
	private relayUrl: string;
	private address: string;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastPongTime = 0;
	private heartbeatInterval: number;
	private pongTimeout: number;
	private messageHandler: ((data: Buffer) => void) | null = null;

	constructor(
		relayUrl: string,
		address: string,
		options?: RelayClientOptions,
	) {
		this.relayUrl = relayUrl;
		this.address = address;
		this.heartbeatInterval = options?.heartbeatInterval ?? 25_000;
		this.pongTimeout = options?.pongTimeout ?? 7_000;
	}

	/**
	 * Connect to the relay server. Resolves when the WebSocket is open.
	 * Rejects if the connection fails.
	 */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const url = `${this.relayUrl}/ws?address=${encodeURIComponent(this.address)}`;
			this.ws = new WebSocket(url);

			this.ws.on("open", () => {
				this.lastPongTime = Date.now();
				this.startHeartbeat();
				resolve();
			});

			this.ws.on("pong", () => {
				this.lastPongTime = Date.now();
			});

			this.ws.on("message", (data: Buffer) => {
				if (this.messageHandler) {
					this.messageHandler(data);
				}
			});

			this.ws.on("close", () => {
				this.cleanup();
			});

			this.ws.on("error", (err: Error) => {
				// If we haven't connected yet, reject the connect promise.
				if (this.ws?.readyState !== WebSocket.OPEN) {
					reject(err);
				}
			});
		});
	}

	/**
	 * Disconnect from the relay server. Closes the WebSocket cleanly
	 * and stops the heartbeat timer.
	 */
	disconnect(): void {
		if (this.ws) {
			this.ws.close(1000, "client disconnect");
			this.cleanup();
		}
	}

	/**
	 * Returns true if the WebSocket connection is currently open.
	 */
	isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	/**
	 * Register a handler for incoming messages.
	 */
	onMessage(handler: (data: Buffer) => void): void {
		this.messageHandler = handler;
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
	 * Clean up heartbeat timer and reset state.
	 */
	private cleanup(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}
}
