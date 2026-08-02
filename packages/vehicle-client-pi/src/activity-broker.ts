/**
 * Cross-extension, best-effort side-channel for structured telemetry --
 * ported from vstack's (github.com/vanillagreencom/vstack) pi-background-tasks
 * activity broker. Completely decoupled from the chat transcript: a
 * publishing Vehicle and a subscribing dashboard/logger extension never
 * import each other, they just agree on this symbol and the event shape.
 *
 * Opt-in by construction: publishing is a true no-op until some other
 * extension actually registers a broker on globalThis. No Vehicle consumer
 * pays any cost (beyond one symbol lookup) unless something is listening.
 */

export type VehicleActivitySeverity = "debug" | "info" | "success" | "warning" | "error";
export type VehicleActivityImportance = "critical" | "important" | "normal" | "noisy";

export interface VehicleActivityEvent {
	readonly type: string;
	readonly source: "vehicle";
	readonly severity: VehicleActivitySeverity;
	readonly importance: VehicleActivityImportance;
	readonly summary: string;
	readonly body?: string;
	readonly refs?: {
		readonly vehicleName?: string;
		readonly operation?: string;
		readonly operationVersion?: number;
		readonly toolCallId?: string;
	};
	readonly details?: Record<string, unknown>;
	readonly ts?: string;
}

export interface VehicleActivityBroker {
	publish(event: VehicleActivityEvent): void;
}

const ACTIVITY_BROKER_SYMBOL = Symbol.for("vehicle.pi.activity");

/** Structural duck typing only -- a broker registered by any extension (Vehicle-authored or not) that exposes a `.publish()` method qualifies. */
function activityBroker(): VehicleActivityBroker | undefined {
	const candidate = (globalThis as unknown as Record<PropertyKey, unknown>)[ACTIVITY_BROKER_SYMBOL];
	return candidate && typeof candidate === "object" && typeof (candidate as VehicleActivityBroker).publish === "function"
		? (candidate as VehicleActivityBroker)
		: undefined;
}

/** Registers this process's activity broker. A second call replaces the first -- callers coordinate ownership themselves, matching the plain globalThis-symbol convention this pattern is built on. */
export function registerActivityBroker(broker: VehicleActivityBroker): void {
	(globalThis as unknown as Record<PropertyKey, unknown>)[ACTIVITY_BROKER_SYMBOL] = broker;
}

export function unregisterActivityBroker(): void {
	delete (globalThis as unknown as Record<PropertyKey, unknown>)[ACTIVITY_BROKER_SYMBOL];
}

/**
 * Publishes one activity event. Never throws -- neither a missing broker nor
 * a broker whose own publish() throws may affect the caller's control flow,
 * matching vstack's own "activity publication is best-effort" contract.
 */
export function publishVehicleActivity(event: VehicleActivityEvent): void {
	try {
		activityBroker()?.publish(event);
	} catch {
		// Best-effort: a subscriber's own bug must never propagate back to the publisher.
	}
}
