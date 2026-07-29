import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
	VehicleClient,
	VehicleFailure,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestOperation,
	VehicleOperationDescriptor,
	VehiclePrincipal,
} from "@danypops/vehicle-core";
import { VehicleError } from "@danypops/vehicle-core";
import { syncManagedActiveTools } from "./pi-tool-availability.js";

export interface PiVehicleIdentity {
	readonly name: string;
	readonly version: string;
	readonly operation: string;
	readonly operationVersion: number;
	readonly toolCallId: string;
}

export interface PiVehicleToolDetails {
	readonly vehicle: PiVehicleIdentity;
	readonly output?: unknown;
	readonly progress?: unknown;
}

export interface PiVehicleInvocationRequest {
	readonly descriptor: VehicleOperationDescriptor;
	readonly manifest: VehicleManifest;
	readonly toolName: string;
	readonly toolCallId: string;
	readonly input: unknown;
	readonly context: ExtensionContext;
}

export type PiVehicleInvocationResolver = (
	request: PiVehicleInvocationRequest,
) => VehicleInvocationOptions | Promise<VehicleInvocationOptions>;

export interface RegisterVehicleToolsOptions {
	readonly permissions?: readonly string[];
	readonly principal?: VehiclePrincipal;
	readonly resolveInvocation?: PiVehicleInvocationResolver;
	readonly toolName?: (descriptor: VehicleOperationDescriptor, versioned: boolean) => string;
	readonly closeClientOnSessionShutdown?: boolean;
}

export interface RegisteredPiVehicleTool {
	readonly toolName: string;
	readonly operationName: string;
	readonly operationVersion: number;
	/** This operation's availability as of the manifest fetch that produced this entry -- see refreshVehicleToolAvailability for keeping it current. */
	readonly available: boolean;
}

export interface RegisteredPiVehicle {
	readonly manifest: VehicleManifest;
	readonly tools: readonly RegisteredPiVehicleTool[];
}

export class PiVehicleInvocationError extends Error {
	constructor(readonly failure: VehicleFailure) {
		super(`${failure.code}: ${failure.message}`);
		this.name = "PiVehicleInvocationError";
	}
}

const RISKY_EFFECTS = new Set<VehicleOperationDescriptor["effect"]>(["destructive", "open-world"]);

function defaultToolName(descriptor: VehicleOperationDescriptor, versioned: boolean): string {
	const base = descriptor.name
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!base) throw new Error(`Vehicle operation ${descriptor.name}@${descriptor.version} has no valid Pi tool name`);
	return versioned ? `${base}_v${descriptor.version}` : base;
}

function operationKey(descriptor: Pick<VehicleOperationDescriptor, "name" | "version">): string {
	return `${descriptor.name}@${descriptor.version}`;
}

function displayLabel(descriptor: VehicleOperationDescriptor): string {
	return descriptor.name
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function formatJson(value: unknown): string {
	const text = JSON.stringify(value, null, 2);
	if (text === undefined) throw new Error("Vehicle returned a non-JSON result");
	return text;
}

function vehicleIdentity(
	manifest: VehicleManifest,
	descriptor: VehicleOperationDescriptor,
	toolCallId: string,
): PiVehicleIdentity {
	return {
		name: manifest.name,
		version: manifest.version,
		operation: descriptor.name,
		operationVersion: descriptor.version,
		toolCallId,
	};
}

function sanitizedFailure(error: unknown): VehicleFailure {
	if (error instanceof VehicleError) return error.toFailure();
	if (error instanceof PiVehicleInvocationError) return error.failure;
	return {
		code: "vehicle-client-failed",
		category: "unavailable",
		message: error instanceof Error ? error.message : "Vehicle client invocation failed",
		retryable: false,
	};
}

function projectedNames(
	manifest: VehicleManifest,
	nameProjector: NonNullable<RegisterVehicleToolsOptions["toolName"]>,
): Array<{ descriptor: VehicleManifestOperation; toolName: string }> {
	const versionCounts = new Map<string, number>();
	for (const descriptor of manifest.operations) {
		versionCounts.set(descriptor.name, (versionCounts.get(descriptor.name) ?? 0) + 1);
	}
	return manifest.operations.map((descriptor) => ({
		descriptor,
		toolName: nameProjector(descriptor, (versionCounts.get(descriptor.name) ?? 0) > 1),
	}));
}

function assertNamesAvailable(
	pi: ExtensionAPI,
	projected: readonly { descriptor: VehicleManifestOperation; toolName: string }[],
): void {
	const owners = new Map<string, string>();
	for (const { descriptor, toolName } of projected) {
		if (!/^[a-zA-Z0-9_-]+$/.test(toolName)) {
			throw new Error(`Projected Pi tool name '${toolName}' for ${operationKey(descriptor)} is invalid`);
		}
		const owner = owners.get(toolName);
		if (owner) {
			throw new Error(`Pi tool name collision: ${owner} and ${operationKey(descriptor)} both project to '${toolName}'`);
		}
		owners.set(toolName, operationKey(descriptor));
	}
	const existing = new Set(pi.getAllTools().map((tool) => tool.name));
	for (const { descriptor, toolName } of projected) {
		if (existing.has(toolName)) {
			throw new Error(`Pi tool '${toolName}' is already registered; refusing to override it with ${operationKey(descriptor)}`);
		}
	}
}

function createTool(
	client: VehicleClient,
	manifest: VehicleManifest,
	descriptor: VehicleOperationDescriptor,
	toolName: string,
	options: RegisterVehicleToolsOptions,
): ToolDefinition<TSchema, PiVehicleToolDetails> {
	return {
		name: toolName,
		label: displayLabel(descriptor),
		description: descriptor.description,
		parameters: descriptor.inputSchema as TSchema,
		async execute(toolCallId, input, signal, onUpdate, context) {
			const identity = vehicleIdentity(manifest, descriptor, toolCallId);
			const resolved = await options.resolveInvocation?.({
				descriptor,
				manifest,
				toolName,
				toolCallId,
				input,
				context,
			});
			if (RISKY_EFFECTS.has(descriptor.effect) && !resolved?.approvalCapability?.trim()) {
				throw new PiVehicleInvocationError({
					code: "approval-capability-required",
					category: "authorization",
					message: `${operationKey(descriptor)} requires an approval capability`,
					retryable: false,
				});
			}

			const reportProgress: VehicleInvocationOptions["onProgress"] = (progress) => {
				onUpdate?.({
					content: [{ type: "text", text: formatJson(progress) }],
					details: { vehicle: identity, progress },
				});
			};
			const invocation: VehicleInvocationOptions = {
				permissions: options.permissions,
				principal: options.principal,
				...resolved,
				operationId: toolCallId,
				correlationId: resolved?.correlationId ?? context.sessionManager.getSessionId(),
				signal,
				onProgress: reportProgress,
				...(descriptor.idempotency.mode === "keyed" && !resolved?.idempotencyKey
					? { idempotencyKey: toolCallId }
					: {}),
			};

			try {
				const output = await client.invoke(descriptor.name, descriptor.version, input, invocation);
				return {
					content: [{ type: "text", text: formatJson(output) }],
					details: { vehicle: identity, output },
				};
			} catch (error) {
				throw new PiVehicleInvocationError(sanitizedFailure(error));
			}
		},
	};
}

export async function registerVehicleTools(
	pi: ExtensionAPI,
	client: VehicleClient,
	options: RegisterVehicleToolsOptions = {},
): Promise<RegisteredPiVehicle> {
	const manifest = await client.manifest();
	const projected = projectedNames(manifest, options.toolName ?? defaultToolName);
	assertNamesAvailable(pi, projected);

	for (const { descriptor, toolName } of projected) {
		pi.registerTool(createTool(client, manifest, descriptor, toolName, options));
	}
	if (options.closeClientOnSessionShutdown) {
		pi.on("session_shutdown", async () => {
			await client.close();
		});
	}

	const tools = projected.map(({ descriptor, toolName }) => ({
		toolName,
		operationName: descriptor.name,
		operationVersion: descriptor.version,
		available: descriptor.available,
	}));
	// Registered tools whose operation is currently unavailable (e.g. a
	// missing credential) are hidden from the LLM from the very first
	// registration -- registering them at all (rather than skipping) keeps
	// them ready to flip active later via refreshVehicleToolAvailability,
	// since Pi has no unregisterTool() to add them back with afterward.
	syncManagedActiveTools(
		pi,
		tools.map((tool) => tool.toolName),
		tools.filter((tool) => tool.available).map((tool) => tool.toolName),
	);

	return { manifest, tools };
}

/**
 * Re-fetches the manifest and re-syncs which of this Vehicle's Pi tools are
 * currently active, without ever re-registering a tool this call has
 * already seen (Pi has no way to re-register under the same name). Any
 * operation present in the fresh manifest but not in `registered` is a
 * genuinely new operation and gets registered for the first time; every
 * previously-known tool just has its active/inactive state re-synced
 * against the operation's current `available` flag.
 *
 * Callers decide their own refresh cadence (a maintenance-task-style
 * interval, a push notification, a session_start recheck); this function
 * only does one refresh pass and returns the updated bookkeeping to pass
 * into the next call.
 */
export async function refreshVehicleToolAvailability(
	pi: ExtensionAPI,
	client: VehicleClient,
	registered: RegisteredPiVehicle,
	options: RegisterVehicleToolsOptions = {},
): Promise<RegisteredPiVehicle> {
	const manifest = await client.manifest();
	const projected = projectedNames(manifest, options.toolName ?? defaultToolName);
	const known = new Set(registered.tools.map((tool) => operationKey({ name: tool.operationName, version: tool.operationVersion })));

	const newlyProjected = projected.filter(({ descriptor }) => !known.has(operationKey(descriptor)));
	if (newlyProjected.length > 0) assertNamesAvailable(pi, newlyProjected);

	const tools: RegisteredPiVehicleTool[] = [];
	for (const { descriptor, toolName } of projected) {
		if (!known.has(operationKey(descriptor))) {
			pi.registerTool(createTool(client, manifest, descriptor, toolName, options));
		}
		tools.push({
			toolName,
			operationName: descriptor.name,
			operationVersion: descriptor.version,
			available: descriptor.available,
		});
	}

	syncManagedActiveTools(
		pi,
		tools.map((tool) => tool.toolName),
		tools.filter((tool) => tool.available).map((tool) => tool.toolName),
	);

	return { manifest, tools };
}
