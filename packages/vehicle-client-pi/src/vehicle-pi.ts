import type {
	VehicleClient,
	VehicleFailure,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestOperation,
	VehicleOperationDescriptor,
	VehiclePrincipal,
} from "@danypops/vehicle-core";
import { extractVehicleContent, VehicleError } from "@danypops/vehicle-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { guardExtensionRuntimeInitialized, syncManagedActiveTools } from "./pi-tool-availability.js";
import { renderVehicleCall, renderVehicleResult } from "./vehicle-render.js";

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

export interface VehicleToolRenderers {
	readonly renderCall?: ToolDefinition<TSchema, PiVehicleToolDetails>["renderCall"];
	readonly renderResult?: ToolDefinition<TSchema, PiVehicleToolDetails>["renderResult"];
}

export interface RegisterVehicleToolsOptions {
	readonly permissions?: readonly string[];
	readonly principal?: VehiclePrincipal;
	readonly resolveInvocation?: PiVehicleInvocationResolver;
	/**
	 * Fires after a successful invoke(), before the tool result is returned -- for a
	 * consumer-local side effect the operation's own output has no way to carry (e.g. a
	 * same-process Pi extension event bus notification a sibling extension observes; a
	 * remote HTTP Vehicle consumer has no such bus, so this is deliberately host-local,
	 * not part of the operation's own transport-neutral contract). Never aborts the tool
	 * call: an error here is swallowed, matching the same "best-effort broadcast" contract
	 * a direct pi.events.emit() call would carry on its own.
	 */
	readonly onInvoked?: (request: PiVehicleInvocationRequest, output: unknown) => void | Promise<void>;
	readonly toolName?: (descriptor: VehicleOperationDescriptor, versioned: boolean) => string;
	readonly closeClientOnSessionShutdown?: boolean;
	/**
	 * Per-operation renderCall/renderResult override. Returning undefined (or
	 * omitting this option entirely) falls back to the generic Vehicle
	 * renderer, which renders effect-colored call rows and a Table/ProgressBar/
	 * collapsible-JSON result view driven by the operation's own descriptor --
	 * see vehicle-render.ts. A consumer with real UX investment in one
	 * operation supplies its own pair here; every other operation still gets
	 * sensible default rendering instead of Pi's raw-JSON fallback.
	 *
	 * This is the HUMAN TUI channel only. The model-facing channel is a
	 * separate concern: see extractVehicleContent in vehicle-core -- an
	 * operation whose output carries its own `content` blocks gets those sent
	 * to the model instead of raw JSON, with no per-registration option needed
	 * here at all, since the operation itself is the only code that knows how
	 * to narrate what it computed.
	 */
	readonly renderers?: (descriptor: VehicleOperationDescriptor) => VehicleToolRenderers | undefined;
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

/** How long a local ctx.ui.confirm() prompt stays open before auto-denying (confirm()'s own documented timeout behavior) -- deliberately shorter than the registry's own DEFAULT_APPROVAL_TIMEOUT_MS so a request never lapses server-side while still mid-prompt locally. */
const LOCAL_APPROVAL_PROMPT_TIMEOUT_MS = 2 * 60_000;

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

function vehicleIdentity(manifest: VehicleManifest, descriptor: VehicleOperationDescriptor, toolCallId: string): PiVehicleIdentity {
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

function approvalRequestId(failure: VehicleFailure): string | undefined {
	const details = failure.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const requestId = (details as { requestId?: unknown }).requestId;
	return typeof requestId === "string" ? requestId : undefined;
}

/**
 * The local, fast-path half of the Approval Gate: VehicleRegistry always
 * records an approval.requested event first (durable, works even with no
 * UI at all); this is the optional synchronous prompt layered on top when
 * ctx.hasUI says one is actually possible. Denies (never throws) on any
 * failure -- a UI error must fail closed, not silently grant.
 */
async function requestLocalApproval(
	context: ExtensionContext,
	descriptor: VehicleOperationDescriptor,
	input: unknown,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (!context.hasUI) return false;
	try {
		return await context.ui.confirm(
			`Approve ${displayLabel(descriptor)}?`,
			`${operationKey(descriptor)} (${descriptor.effect} effect) requests approval before it can run.\n\nInput:\n${formatJson(input)}`,
			{ signal, timeout: LOCAL_APPROVAL_PROMPT_TIMEOUT_MS },
		);
	} catch {
		return false;
	}
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

function assertNamesAvailable(pi: ExtensionAPI, projected: readonly { descriptor: VehicleManifestOperation; toolName: string }[]): void {
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
	const existing = new Set(guardExtensionRuntimeInitialized(() => pi.getAllTools()).map((tool) => tool.name));
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
	const overrides = options.renderers?.(descriptor);
	return {
		name: toolName,
		label: displayLabel(descriptor),
		description: descriptor.description,
		// Without this, Pi omits the tool from the "Available tools" section of
		// its default system prompt entirely -- confirmed live: a projected tool
		// was registered and technically callable, but the model had no way to
		// know it existed and reported it as unavailable when asked directly.
		promptSnippet: descriptor.description,
		parameters: descriptor.inputSchema as TSchema,
		renderCall: overrides?.renderCall ?? ((args, theme, context) => renderVehicleCall(descriptor, args, theme, context)),
		renderResult:
			overrides?.renderResult ??
			((result, resultOptions, theme, context) => renderVehicleResult(descriptor, result, resultOptions, theme, context)),
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

			const reportProgress: VehicleInvocationOptions["onProgress"] = (progress) => {
				onUpdate?.({
					content: [{ type: "text", text: formatJson(progress) }],
					details: { vehicle: identity, progress },
				});
			};
			const baseInvocation: VehicleInvocationOptions = {
				permissions: options.permissions,
				principal: options.principal,
				...resolved,
				operationId: toolCallId,
				correlationId: resolved?.correlationId ?? context.sessionManager.getSessionId(),
				signal,
				onProgress: reportProgress,
				...(descriptor.idempotency.mode === "keyed" && !resolved?.idempotencyKey ? { idempotencyKey: toolCallId } : {}),
			};

			let output: unknown;
			try {
				output = await client.invoke(descriptor.name, descriptor.version, input, baseInvocation);
			} catch (error) {
				const failure = sanitizedFailure(error);
				// The registry (once configureApprovals() is enabled there) records a
				// durable approval.requested event before ever failing this way -- a
				// caller always has a path forward via vehicle.approval.resolve, this
				// is just the optional local fast path attempting it automatically.
				if (failure.code !== "approval-required") throw new PiVehicleInvocationError(failure);
				const requestId = approvalRequestId(failure);
				// No requestId to act on, or no UI capable of asking -- the request
				// stays durably pending (an async/remote approver can still resolve it
				// later) rather than this call eagerly denying it on the caller's behalf.
				if (!requestId || !context.hasUI) throw new PiVehicleInvocationError(failure);

				const approved = await requestLocalApproval(context, descriptor, input, signal);
				let capability: string | undefined;
				try {
					const resolveOutput = (await client.invoke(
						"vehicle.approval.resolve",
						1,
						{ requestId, decision: approved ? "granted" : "denied" },
						{ permissions: options.permissions, principal: options.principal, signal },
					)) as { capability?: string };
					capability = resolveOutput.capability;
				} catch {
					// The resolve round trip itself failed (missing permission, expired
					// request) -- fall through to the original approval-required failure,
					// never mint or assume a capability that was never actually granted.
				}
				if (!capability) throw new PiVehicleInvocationError(failure);
				try {
					output = await client.invoke(descriptor.name, descriptor.version, input, { ...baseInvocation, approvalCapability: capability });
				} catch (retryError) {
					throw new PiVehicleInvocationError(sanitizedFailure(retryError));
				}
			}
			if (options.onInvoked) {
				try {
					await options.onInvoked({ descriptor, manifest, toolName, toolCallId, input, context }, output);
				} catch {
					// Best-effort: the invoke() itself already succeeded, so a broadcast failure
					// must never surface as a failed tool call.
				}
			}
			const content = extractVehicleContent(output) ?? [{ type: "text" as const, text: formatJson(output) }];
			return {
				content: [...content],
				details: { vehicle: identity, output },
			};
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
