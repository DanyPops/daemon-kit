/**
 * Standardizes the watch/unwatch operation-pair shape any Vehicle provider
 * can adopt: {resource} -> {watchId, topic} / {watchId} -> {unwatched},
 * built on the shared WatchRegistry (vehicle-core) bookkeeping and the same
 * PushChannel transport substrate Vehicle Events introduced. A provider
 * still owns detecting when its own resource actually changed and
 * publishing to the returned topic (vehicleWatchTopic(watchId), typically
 * via the same PushChannel/bridgeVehicleEventsToPushChannel-shaped
 * publish() call already used elsewhere) -- pattern-matching against a
 * real changed resource is deliberately not this module's job, mirroring
 * WatchRegistry's own stated boundary.
 */
import { randomUUID } from "node:crypto";
import {
	bindVehicleOperation,
	defineVehicleOperation,
	defineVehicleSchema,
	type VehicleLimits,
	type VehicleOperationBinding,
	type VehicleOperationContext,
	vehicleWatchTopic,
	type WatchRegistry,
} from "@danypops/vehicle-core";

export interface VehicleWatchInput {
	readonly resource: string;
}

export interface VehicleWatchOutput {
	readonly watchId: string;
	readonly topic: string;
}

export interface VehicleUnwatchInput {
	readonly watchId: string;
}

export interface VehicleUnwatchOutput {
	readonly unwatched: boolean;
}

const watchInputSchema = defineVehicleSchema<VehicleWatchInput>({
	jsonSchema: { type: "object", properties: { resource: { type: "string" } }, required: ["resource"], additionalProperties: false },
	safeParse(value) {
		if (typeof value !== "object" || value === null) return { success: false, issues: [{ path: [], message: "input must be an object" }] };
		const resource = (value as { resource?: unknown }).resource;
		if (typeof resource !== "string" || !resource.trim()) {
			return { success: false, issues: [{ path: ["resource"], message: "resource must be a non-empty string" }] };
		}
		return { success: true, value: { resource } };
	},
});

const watchOutputSchema = defineVehicleSchema<VehicleWatchOutput>({
	jsonSchema: {
		type: "object",
		properties: { watchId: { type: "string" }, topic: { type: "string" } },
		required: ["watchId", "topic"],
		additionalProperties: false,
	},
	safeParse(value) {
		const row = value as { watchId?: unknown; topic?: unknown };
		if (typeof row?.watchId !== "string" || typeof row.topic !== "string") {
			return { success: false, issues: [{ path: [], message: "watchId and topic must be strings" }] };
		}
		return { success: true, value: { watchId: row.watchId, topic: row.topic } };
	},
});

const unwatchInputSchema = defineVehicleSchema<VehicleUnwatchInput>({
	jsonSchema: { type: "object", properties: { watchId: { type: "string" } }, required: ["watchId"], additionalProperties: false },
	safeParse(value) {
		const watchId = (value as { watchId?: unknown })?.watchId;
		if (typeof watchId !== "string" || !watchId.trim()) {
			return { success: false, issues: [{ path: ["watchId"], message: "watchId must be a non-empty string" }] };
		}
		return { success: true, value: { watchId } };
	},
});

const unwatchOutputSchema = defineVehicleSchema<VehicleUnwatchOutput>({
	jsonSchema: { type: "object", properties: { unwatched: { type: "boolean" } }, required: ["unwatched"], additionalProperties: false },
	safeParse(value) {
		const unwatched = (value as { unwatched?: unknown })?.unwatched;
		if (typeof unwatched !== "boolean") return { success: false, issues: [{ path: ["unwatched"], message: "unwatched must be a boolean" }] };
		return { success: true, value: { unwatched } };
	},
});

const DEFAULT_SCOPE = "default";

export interface CreateVehicleWatchOperationsOptions {
	/** Names the operation family: produces "${name}.watch" and "${name}.unwatch". */
	readonly name: string;
	/** Defaults to 1. */
	readonly version?: number;
	readonly registry: WatchRegistry;
	readonly limits: VehicleLimits;
	readonly permissions?: readonly string[];
	/**
	 * Derives the bounding scope a watch counts against (WatchRegistry's own
	 * per-scope cap). Defaults to one fixed shared scope -- the walking
	 * skeleton's own single-bucket shape; override for real per-workspace or
	 * per-principal bounding once a provider needs it.
	 */
	readonly scopeOf?: (context: VehicleOperationContext<VehicleWatchInput>) => string;
}

export interface VehicleWatchOperations {
	readonly watch: VehicleOperationBinding<VehicleWatchInput, VehicleWatchOutput>;
	readonly unwatch: VehicleOperationBinding<VehicleUnwatchInput, VehicleUnwatchOutput>;
}

export function createVehicleWatchOperations(options: CreateVehicleWatchOperationsOptions): VehicleWatchOperations {
	const version = options.version ?? 1;
	const scopeOf = options.scopeOf ?? (() => DEFAULT_SCOPE);

	const WatchOperation = defineVehicleOperation({
		name: `${options.name}.watch`,
		version,
		description: `Registers interest in a resource under the "${options.name}" watch family; returns a topic to subscribe to for change notifications.`,
		input: watchInputSchema,
		output: watchOutputSchema,
		permissions: options.permissions,
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: options.limits,
	});

	const UnwatchOperation = defineVehicleOperation({
		name: `${options.name}.unwatch`,
		version,
		description: `Removes a previously registered "${options.name}" watch by id.`,
		input: unwatchInputSchema,
		output: unwatchOutputSchema,
		permissions: options.permissions,
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: options.limits,
	});

	const watch = bindVehicleOperation(WatchOperation, () => async (context) => {
		const scope = scopeOf(context);
		const watchId = randomUUID();
		const registration = options.registry.add(scope, context.input.resource, watchId, vehicleWatchTopic(watchId));
		return { watchId: registration.watchId, topic: registration.topic };
	});

	const unwatch = bindVehicleOperation(UnwatchOperation, () => async (context) => {
		const registration = options.registry.remove(context.input.watchId);
		return { unwatched: registration !== undefined };
	});

	return { watch, unwatch };
}
