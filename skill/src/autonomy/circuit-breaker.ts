/**
 * CircuitBreaker auto-downgrades connections to Full Manual when
 * anomalous behavior is detected.
 *
 * 4 trigger types: message_flood, permission_violation, spending_exceeded,
 * boundary_probe. Uses sliding window counters for each trigger.
 *
 * Per locked decisions:
 * - Downgrade is straight to Full Manual (no gradual step-down).
 * - Human must manually re-upgrade after trip (no automatic recovery).
 * - Trip event appears in activity feed with trigger details + warning badge.
 * - circuitBreakerTripped flag persists on connection across restarts.
 */

import type { ConnectionStore } from "../connection-store.js";
import type { ActivityFeed } from "./activity-feed.js";

export type TriggerType =
	| "message_flood"
	| "permission_violation"
	| "spending_exceeded"
	| "boundary_probe";

export interface CircuitBreakerConfig {
	/** Max messages per window before flood trip. Default: 50. */
	floodThreshold: number;
	/** Window size for flood detection in ms. Default: 60_000 (1 minute). */
	floodWindowMs: number;
	/** Max permission violations per window before trip. Default: 5. */
	violationThreshold: number;
	/** Window size for violation detection in ms. Default: 300_000 (5 minutes). */
	violationWindowMs: number;
	/** Max boundary probe escalations per window before trip. Default: 3. */
	boundaryProbeThreshold: number;
	/** Window for boundary probe detection in ms. Default: 600_000 (10 minutes). */
	boundaryProbeWindowMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
	floodThreshold: 50,
	floodWindowMs: 60_000,
	violationThreshold: 5,
	violationWindowMs: 300_000,
	boundaryProbeThreshold: 3,
	boundaryProbeWindowMs: 600_000,
};

interface EventRecord {
	timestamp: number;
	type: TriggerType;
}

/**
 * CircuitBreaker monitors connection behavior via sliding window counters
 * and auto-downgrades to Full Manual when thresholds are exceeded.
 */
export class CircuitBreaker {
	private events: Map<string, EventRecord[]> = new Map();
	private config: CircuitBreakerConfig;

	constructor(
		private connectionStore: ConnectionStore,
		private activityFeed: ActivityFeed,
		config?: Partial<CircuitBreakerConfig>,
	) {
		this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
	}

	/**
	 * Record a message event for flood detection.
	 * Checks flood threshold after recording.
	 */
	recordMessage(connectionAddress: string): void {
		this.addEvent(connectionAddress, "message_flood");
		this.checkAndTrip(connectionAddress);
	}

	/**
	 * Record a violation event (permission_violation, spending_exceeded,
	 * or boundary_probe). Checks all thresholds after recording.
	 */
	recordViolation(
		connectionAddress: string,
		type: "permission_violation" | "spending_exceeded" | "boundary_probe",
	): void {
		this.addEvent(connectionAddress, type);
		this.checkAndTrip(connectionAddress);
	}

	/**
	 * Check if a connection's circuit breaker has been tripped.
	 * Reads from persisted state (not in-memory counters).
	 */
	isTripped(connectionAddress: string): boolean {
		const connection =
			this.connectionStore.getConnection(connectionAddress);
		return connection?.circuitBreakerTripped === true;
	}

	/**
	 * Add an event to the sliding window for a connection.
	 */
	private addEvent(connectionAddress: string, type: TriggerType): void {
		if (!this.events.has(connectionAddress)) {
			this.events.set(connectionAddress, []);
		}
		this.events.get(connectionAddress)!.push({
			timestamp: Date.now(),
			type,
		});
		this.pruneOldEvents(connectionAddress);
	}

	/**
	 * Check all counters against thresholds. If any exceeded:
	 * 1. Downgrade to full_manual via connectionStore.
	 * 2. Set circuitBreakerTripped flag.
	 * 3. Persist to disk.
	 * 4. Record activity feed event with trigger details.
	 *
	 * @returns true if any threshold was exceeded (tripped).
	 */
	private checkAndTrip(connectionAddress: string): boolean {
		// Don't trip again if already tripped
		if (this.isTripped(connectionAddress)) return true;

		const events = this.events.get(connectionAddress) ?? [];
		const now = Date.now();

		// Check each trigger type against its threshold and window
		const checks: Array<{
			type: TriggerType;
			threshold: number;
			windowMs: number;
		}> = [
			{
				type: "message_flood",
				threshold: this.config.floodThreshold,
				windowMs: this.config.floodWindowMs,
			},
			{
				type: "permission_violation",
				threshold: this.config.violationThreshold,
				windowMs: this.config.violationWindowMs,
			},
			{
				type: "spending_exceeded",
				threshold: this.config.violationThreshold,
				windowMs: this.config.violationWindowMs,
			},
			{
				type: "boundary_probe",
				threshold: this.config.boundaryProbeThreshold,
				windowMs: this.config.boundaryProbeWindowMs,
			},
		];

		for (const check of checks) {
			const count = events.filter(
				(e) =>
					e.type === check.type &&
					e.timestamp > now - check.windowMs,
			).length;

			if (count >= check.threshold) {
				this.trip(connectionAddress, check.type, count, check.threshold, check.windowMs);
				return true;
			}
		}

		return false;
	}

	/**
	 * Execute the circuit breaker trip: downgrade, flag, persist, log.
	 */
	private trip(
		connectionAddress: string,
		trigger: TriggerType,
		count: number,
		threshold: number,
		windowMs: number,
	): void {
		// 1. Downgrade to full_manual (use updateConnection to avoid
		//    setAutonomy's confirmation gate for full_auto)
		this.connectionStore.updateConnection(connectionAddress, {
			autonomyLevel: "full_manual",
		});

		// 2. Set circuitBreakerTripped flag
		this.connectionStore.updateConnection(connectionAddress, {
			circuitBreakerTripped: true,
		});

		// 3. Persist (async, fire-and-forget -- save() is async but
		//    the trip itself must be synchronous for pipeline flow)
		this.connectionStore.save();

		// 4. Record activity feed event
		this.activityFeed.record({
			connectionAddress,
			eventType: "circuit_breaker_tripped",
			badge: "circuit_breaker",
			details: JSON.stringify({
				trigger,
				count,
				threshold,
				windowMs,
			}),
		});
	}

	/**
	 * Remove events older than the longest configured window
	 * to prevent unbounded memory growth.
	 */
	private pruneOldEvents(connectionAddress: string): void {
		const events = this.events.get(connectionAddress);
		if (!events) return;

		const longestWindow = Math.max(
			this.config.floodWindowMs,
			this.config.violationWindowMs,
			this.config.boundaryProbeWindowMs,
		);
		const cutoff = Date.now() - longestWindow;

		const pruned = events.filter((e) => e.timestamp > cutoff);
		this.events.set(connectionAddress, pruned);
	}
}
