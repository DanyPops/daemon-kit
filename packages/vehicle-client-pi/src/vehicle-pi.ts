import type {
	AtomicJsonFsAdapter,
	VehicleClient,
	VehicleContentBlock,
	VehicleEffect,
	VehicleFailure,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestOperation,
	VehicleOperationDescriptor,
	VehiclePrincipal,
} from "@danypops/vehicle-core";
import {
	boundedCauseMessage,
	createAtomicJsonWriter,
	extractVehicleContent,
	VEHICLE_APPROVAL_RESOLVE_OPERATION_NAME,
	VehicleError,
} from "@danypops/vehicle-core";
import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolExecutionMode,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { publishVehicleActivity } from "./activity-broker.js";
import { guardExtensionRuntimeInitialized, syncManagedActiveTools, tryExtensionRuntimeAction } from "./pi-tool-availability.js";
import { renderVehicleCall, renderVehicleResult } from "./vehicle-render.js";
import { classifyVehicleOperationSafety, type VehicleSafetyPolicyStore, type VehicleSafetyState } from "./vehicle-safety.js";
import { registerVehicleSafetyContributor } from "./vehicle-safety-registry.js";
import {
	applyVehicleShellActivation,
	refreshVehicleShellManagedTools,
	registerVehicleShell,
	type VehicleShellHandle,
	type VehicleShellOptions,
} from "./vehicle-shell.js";

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
	/** The tool call's own cancellation signal -- present on every request; here for interactiveFollowUps (or any future consumer) to make its own extra round trip abortable too. */
	readonly signal?: AbortSignal;
	/** The tool call's own progress-update callback -- lets an interactiveFollowUp report an in-progress status (e.g. "waiting for a human answer") the same way the primary invoke()'s own onProgress does. */
	readonly onUpdate?: AgentToolUpdateCallback<PiVehicleToolDetails>;
}

export type PiVehicleInvocationResolver = (
	request: PiVehicleInvocationRequest,
) => VehicleInvocationOptions | Promise<VehicleInvocationOptions>;

export interface VehicleToolRenderers {
	readonly renderCall?: ToolDefinition<TSchema, PiVehicleToolDetails>["renderCall"];
	readonly renderResult?: ToolDefinition<TSchema, PiVehicleToolDetails>["renderResult"];
}

export interface PiVehicleFollowUpResult {
	readonly content: readonly VehicleContentBlock[];
	/** Replaces the human-facing details.output the primary invoke() would otherwise carry; details.vehicle is always the real identity regardless. */
	readonly output?: unknown;
}

/**
 * An optional client-local interactive step run after a successful invoke(),
 * before the tool result is returned to the model -- for an operation whose
 * own real UX needs more than "call it, show the output" (e.g. an operation
 * that durably records something and separately wants to offer a synchronous
 * human round-trip when ctx.hasUI allows one). Returning undefined falls back
 * to the default content/details built from the primary output; a thrown
 * error propagates as a real tool failure -- the primary invoke() already
 * succeeded and is not rolled back, matching this same contract on any other
 * mutating operation whose follow-up step fails.
 *
 * Deliberately distinct from the Approval Gate's own local-confirm fast path
 * (baked directly into execute() itself, since every gated operation needs
 * the identical approval-required/resolve dance): this hook is for a
 * per-operation, per-consumer interactive shape nothing else shares, the way
 * Papyrus's discuss.open/discuss.reply use it to offer a live human answer.
 */
export type PiVehicleInteractiveFollowUp = (
	request: PiVehicleInvocationRequest,
	output: unknown,
	client: VehicleClient,
) => Promise<PiVehicleFollowUpResult | undefined>;

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
	/**
	 * Per-operation escape hatch for a client-local interactive step after a
	 * successful invoke() -- see PiVehicleInteractiveFollowUp. Returning
	 * undefined (or omitting this option, or the resolver itself returning
	 * undefined for a given descriptor) means every operation behaves exactly
	 * as before this option existed: default content/details from the
	 * primary output, no extra round trip.
	 */
	readonly interactiveFollowUps?: (descriptor: VehicleOperationDescriptor) => PiVehicleInteractiveFollowUp | undefined;
	/**
	 * Per-operation override for Pi's own tool-call concurrency semantics --
	 * e.g. "sequential" for an operation whose interactiveFollowUps prompts a
	 * human synchronously, so the model can't batch it alongside other tool
	 * calls and let those run before the human sees the prompt. Undefined (the
	 * default for every operation) means Pi's own default concurrency mode,
	 * unchanged from today.
	 */
	readonly executionMode?: (descriptor: VehicleOperationDescriptor) => ToolExecutionMode | undefined;
	/**
	 * Mirrors the server's own VehicleRegistry.configureApprovals()
	 * requireApprovalForEffects set (see vehicle-server) so /safety's "ask"
	 * classification matches reality -- purely advisory here: the server
	 * enforces its own copy regardless of what this option says. Defaults to
	 * DEFAULT_APPROVAL_EFFECTS, the same default the server itself uses.
	 */
	readonly requireApprovalForEffects?: readonly VehicleEffect[];
	/**
	 * A human's own /safety overrides, consulted ahead of the effect-level
	 * default and the permission-based check for both tool visibility (see
	 * syncManagedActiveTools below) and the local pre-invoke approval gate
	 * (see createTool's execute()). Omitted means no overrides exist --
	 * classification falls back to permissions+effect exactly as before this
	 * option existed, a zero-behavior-change default.
	 */
	readonly safetyPolicyStore?: VehicleSafetyPolicyStore;
	/**
	 * Survives a restart/reload while the daemon is unreachable: a successful
	 * manifest() fetch is persisted here (atomic write, best-effort -- a failed
	 * write never fails registration); a failed factory-time fetch falls back
	 * to reading this file instead of throwing, so tool definitions and their
	 * renderers still exist for transcript replay of a historical tool call
	 * even while offline. Live availability (available/permissions) still only
	 * ever comes from a real manifest -- see RegisteredPiVehicle.stale and
	 * refreshVehicleToolAvailability, which callers should still wire to
	 * session_start (e.g. via registerVehicleStatusRefresh) to reconcile once
	 * the daemon is reachable again. Omitted (the default) preserves today's
	 * behavior: a factory-time manifest() failure throws.
	 */
	readonly manifestCache?: { readonly filePath: string; readonly fs: AtomicJsonFsAdapter };
	/**
	 * Bounded retry/backoff around the initial manifest handshake -- the real-world gap this
	 * closes: a Pi extension's session_start calls registerVehicleTools() exactly once, and a
	 * daemon that is transiently unreachable at that exact moment (mid-restart from a
	 * legitimate version-check kill/respawn, or a package update swapping files out from under
	 * a live process) previously meant every Vehicle-projected tool was silently, permanently
	 * missing for the rest of that session -- no reload required to trigger it, and no reload
	 * could fix it either, since the next session_start would just race the same restart again
	 * if it was still in progress. Modeled on connectPushChannel's own jittered exponential
	 * backoff (min/max/growFactor, +/-20% jitter) and gRPC/Kubernetes-style bounded readiness
	 * probing: retry a few times over roughly half a second, then give up -- long enough to
	 * survive a real restart (observed ~100-300ms in production), short enough that a
	 * genuinely-down daemon still fails fast. Defaults to attempts:4, initialDelayMs:50,
	 * maxDelayMs:500, growFactor:2.5. Set attempts:1 to restore the old immediate-failure
	 * behavior exactly.
	 */
	readonly handshake?: RegisterVehicleToolsHandshakeOptions;
	/**
	 * Opt-in Vehicle Shell activation: instead of activating every available, permitted operation
	 * (this option's own default omission), registers two always-on meta-tools (tools_list,
	 * tools_man by default) and keeps most operations inactive behind a decaying-TTL cache -- see
	 * vehicle-shell.ts. Exists because a Vehicle with dozens of operations otherwise puts every
	 * single one's full schema in context from turn one, regardless of whether the session ever
	 * calls it. Omitted (the default) preserves today's all-active behavior exactly, for every
	 * existing consumer that hasn't opted in.
	 */
	readonly shell?: VehicleShellOptions;
}

export interface RegisterVehicleToolsHandshakeOptions {
	/** Total attempts at the initial manifest fetch, including the first. Defaults to 4. */
	readonly attempts?: number;
	/** Delay before the second attempt. Defaults to 50ms. */
	readonly initialDelayMs?: number;
	/** No retry delay is ever allowed to exceed this. Defaults to 500ms. */
	readonly maxDelayMs?: number;
	/** Multiplier applied to the delay after each failed attempt. Defaults to 2.5. */
	readonly growFactor?: number;
}

export interface RegisteredPiVehicleTool {
	readonly toolName: string;
	readonly operationName: string;
	readonly operationVersion: number;
	/** This operation's availability as of the manifest fetch that produced this entry -- see refreshVehicleToolAvailability for keeping it current. */
	readonly available: boolean;
	/** Whether options.permissions, as of this registration/refresh, actually covers descriptor.permissions -- see permissionsSatisfied(). A tool is only ever active when both this and `available` are true. */
	readonly permissionsSatisfied: boolean;
	readonly effect: VehicleEffect;
	/** Resolved allow/ask/blocked -- see classifyVehicleOperationSafety(). A tool is only ever active when `available` is true and this isn't "blocked". */
	readonly safetyState: VehicleSafetyState;
}

export interface RegisteredPiVehicle {
	readonly manifest: VehicleManifest;
	readonly tools: readonly RegisteredPiVehicleTool[];
	/** True when `manifest` came from options.manifestCache's sidecar file rather than a live fetch -- the daemon was unreachable at registration/refresh time. A caller that cares (e.g. to show a reconnecting indicator) can check this; every existing caller ignoring it sees no behavior change. */
	readonly stale: boolean;
	/** Present only when options.shell was given -- pass this back into refreshVehicleToolAvailability so a later refresh keeps using the same TTL tracker instead of reactivating every available operation. */
	readonly shell?: VehicleShellHandle;
}

/** sanitizedFailure()'s own fallback code for a raw transport-level throw -- carries zero information on its own (every failure is "a vehicle client failed"), unlike a real domain code (not-found, validation, deadline-exceeded, ...) which is worth showing as-is. */
const GENERIC_TRANSPORT_FAILURE_CODE = "vehicle-client-failed";

/**
 * Renders failure.details' own primitive fields (e.g. a capacity failure's { actualBytes,
 * maxBytes }) into the same parenthesized annotation causeMessage already gets -- undefined for
 * anything else (no details, a non-object, an array, or an object with no primitive fields),
 * since an arbitrary nested JsonValue isn't safe to inline into a one-line error message.
 */
function formatFailureDetails(details: VehicleFailure["details"]): string | undefined {
	if (details === undefined || details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
	const parts = Object.entries(details)
		.filter((entry): entry is [string, string | number | boolean] => {
			const value = entry[1];
			return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
		})
		.map(([key, value]) => `${key}=${value}`);
	return parts.length === 0 ? undefined : parts.join(", ");
}

export class PiVehicleInvocationError extends Error {
	constructor(
		readonly failure: VehicleFailure,
		/** The failing Vehicle's own manifest name (e.g. "papyrus") -- substituted for the generic transport-failure code so the visible message says which backend failed instead of repeating a label that's true of every such failure. */
		vehicleName?: string,
	) {
		// causeMessage and details.{actualBytes,maxBytes} etc. were captured but never shown -- Pi
		// surfaces this .message, not .failure, so a capacity failure otherwise gives no way to know
		// how far over the cap the real payload was or what limit would fit.
		const label = failure.code === GENERIC_TRANSPORT_FAILURE_CODE && vehicleName ? vehicleName : failure.code;
		const annotations = [failure.causeMessage, formatFailureDetails(failure.details)].filter((part): part is string => part !== undefined);
		const annotation = annotations.length === 0 ? "" : ` (${annotations.join("; ")})`;
		super(`${label}: ${failure.message}${annotation}`);
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

/**
 * Same superset check VehicleRegistry.invoke() already enforces at
 * invoke-time -- this is that same rule applied one step earlier, to tool
 * *visibility*, so a caller never sees a tool it has no permissions to call
 * in the first place. An operation with no declared permissions is always
 * satisfied, matching the registry's own "missing.length === 0" logic.
 */
function permissionsSatisfied(required: readonly string[], granted: readonly string[] | undefined): boolean {
	if (required.length === 0) return true;
	const grantedSet = new Set(granted ?? []);
	return required.every((permission) => grantedSet.has(permission));
}

function resolveSafetyState(
	manifestName: string,
	descriptor: VehicleOperationDescriptor,
	options: RegisterVehicleToolsOptions,
): VehicleSafetyState {
	return classifyVehicleOperationSafety({
		permissionsSatisfied: permissionsSatisfied(descriptor.permissions, options.permissions),
		effect: descriptor.effect,
		requireApprovalForEffects: options.requireApprovalForEffects ? new Set(options.requireApprovalForEffects) : undefined,
		override: options.safetyPolicyStore?.get(manifestName, descriptor.name),
	});
}

/**
 * Unconditional, matching the Activity Broker's own convention -- /safety
 * sees every Vehicle a session has registered without any extension needing
 * to wire itself in separately. Re-registering under the same manifest name
 * (a refresh) simply replaces the prior contributor's resolve() closure.
 */
function contributeToSafetyRegistry(manifest: VehicleManifest, tools: readonly RegisteredPiVehicleTool[]): void {
	registerVehicleSafetyContributor({
		source: manifest.name,
		resolve: () => ({
			vehicleName: manifest.name,
			tools: tools.map((tool) => ({
				toolName: tool.toolName,
				operationName: tool.operationName,
				effect: tool.effect,
				state: tool.safetyState,
			})),
		}),
	});
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

/**
 * Side-channel telemetry only -- a true no-op unless some other extension has
 * called registerActivityBroker() (see activity-broker.ts). Never gated
 * behind a RegisterVehicleToolsOptions flag: the broker's own absence is
 * already the opt-in mechanism, matching vstack's own unconditional-call
 * convention this primitive is ported from.
 */
function publishOperationActivity(
	kind: "started" | "completed" | "failed",
	identity: PiVehicleIdentity,
	descriptor: VehicleOperationDescriptor,
	details?: Record<string, unknown>,
): void {
	publishVehicleActivity({
		type: `vehicle.operation.${kind}`,
		source: "vehicle",
		severity: kind === "failed" ? "error" : kind === "completed" ? "success" : "info",
		importance:
			kind === "started" ? "noisy" : descriptor.effect === "destructive" || descriptor.effect === "open-world" ? "important" : "normal",
		summary: `${operationKey(descriptor)} ${kind}`,
		refs: {
			vehicleName: identity.name,
			operation: identity.operation,
			operationVersion: identity.operationVersion,
			toolCallId: identity.toolCallId,
		},
		details: { effect: descriptor.effect, ...details },
		ts: new Date().toISOString(),
	});
}

function sanitizedFailure(error: unknown): VehicleFailure {
	if (error instanceof VehicleError) return error.toFailure();
	if (error instanceof PiVehicleInvocationError) return error.failure;
	// This branch only ever sees a raw transport-level throw (a stale/dead connection, a fetch()
	// failure, a stream read error) -- never a domain rejection, which VehicleError already carries
	// its own opt-in exposeCause for. Node's fetch() populates a TypeError's .cause with the real
	// underlying reason (ECONNREFUSED, ECONNRESET, a DNS failure); a real live incident was
	// diagnosable only as the opaque top-level "fetch failed" until this was captured.
	const causeMessage = error instanceof Error ? boundedCauseMessage(error.cause) : undefined;
	return {
		code: GENERIC_TRANSPORT_FAILURE_CODE,
		category: "unavailable",
		message: error instanceof Error ? error.message : "Vehicle client invocation failed",
		retryable: false,
		...(causeMessage === undefined ? {} : { causeMessage }),
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

/**
 * Never projects VEHICLE_APPROVAL_RESOLVE_OPERATION_NAME as a Pi tool, even
 * when it's present in the manifest (any registry with configureApprovals()
 * enabled registers it) and the caller's own options.permissions happens to
 * cover its required permission. It is invoked exactly one way in this
 * package -- client.invoke() from inside the approval-required retry dance
 * below, using options.permissions the extension author fixed at
 * registration time -- never as a tool call a model can choose to make.
 * Exposing it as a model-callable tool would let a model grant its own
 * pending approval requests, defeating the human-in-the-loop point of the
 * gate entirely.
 */
function projectedNames(
	manifest: VehicleManifest,
	nameProjector: NonNullable<RegisterVehicleToolsOptions["toolName"]>,
): Array<{ descriptor: VehicleManifestOperation; toolName: string }> {
	const versionCounts = new Map<string, number>();
	for (const descriptor of manifest.operations) {
		versionCounts.set(descriptor.name, (versionCounts.get(descriptor.name) ?? 0) + 1);
	}
	return manifest.operations
		.filter((descriptor) => descriptor.name !== VEHICLE_APPROVAL_RESOLVE_OPERATION_NAME)
		.map((descriptor) => ({
			descriptor,
			toolName: nameProjector(descriptor, (versionCounts.get(descriptor.name) ?? 0) > 1),
		}));
}

function assertNamesAvailable(
	projected: readonly { descriptor: VehicleManifestOperation; toolName: string }[],
	existingToolNames: readonly string[],
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
	const existing = new Set(existingToolNames);
	for (const { descriptor, toolName } of projected) {
		if (existing.has(toolName)) {
			throw new Error(`Pi tool '${toolName}' is already registered; refusing to override it with ${operationKey(descriptor)}`);
		}
	}
}

export interface VehicleOperationInvocationParams {
	readonly client: VehicleClient;
	readonly manifest: VehicleManifest;
	readonly descriptor: VehicleOperationDescriptor;
	/** The name a consumer's own tool call is presented under -- purely for identity/telemetry; does not have to be descriptor's own projected Pi tool name (a consolidated multi-action tool passes its own single name for every sub-action it dispatches). */
	readonly toolName: string;
	readonly toolCallId: string;
	readonly input: unknown;
	readonly context: ExtensionContext;
	readonly signal?: AbortSignal;
	readonly onUpdate?: AgentToolUpdateCallback<PiVehicleToolDetails>;
	readonly options: RegisterVehicleToolsOptions;
}

export interface VehicleOperationInvocationResult {
	readonly content: readonly VehicleContentBlock[];
	readonly details: PiVehicleToolDetails;
}

/**
 * The cross-cutting policy layer every registerVehicleTools()-registered tool
 * gets for free -- activity broadcasting, the local /safety "ask" gate, the
 * server approval-required retry dance, idempotency-key/correlationId
 * derivation, resolveInvocation/onInvoked/interactiveFollowUps hooks -- as a
 * standalone Decorator around a single operation call, independent of how
 * (or whether) that call is fronted by a Pi tool at all.
 *
 * Exists because registerVehicleTools()'s one-operation-to-one-tool
 * projection is a deliberate, correct default (Anthropic's own tool-design
 * guidance: consolidate related actions behind one tool with an action
 * parameter, rather than one tool per action) but is not the only legitimate
 * tool shape -- a consumer whose tool already consolidates several
 * operations behind an action/operation parameter (see e.g. web-spider's
 * web_category) cannot use registerVehicleTools() for that tool without
 * regressing its existing one-tool-many-actions contract into several
 * separate tools. Before this function existed, the only escape hatch was
 * calling client.invoke() directly, which silently forfeited every one of
 * the above cross-cutting behaviors -- exactly the gap this closes: a
 * consumer keeps full control of its own tool registration/schema/dispatch
 * shape while still calling through the same policy layer
 * registerVehicleTools() uses internally.
 */
export async function invokeVehicleOperation(params: VehicleOperationInvocationParams): Promise<VehicleOperationInvocationResult> {
	const { client, manifest, descriptor, toolName, toolCallId, input, context, signal, onUpdate, options } = params;
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

	publishOperationActivity("started", identity, descriptor);

	// A human's own /safety override, not the effect-level default (that
	// case is already covered by the approval-required round trip below) --
	// a client-only gate, never touches invoke() at all on denial, so no
	// server capability is needed for an effect the server itself never
	// gates.
	if (options.safetyPolicyStore?.get(manifest.name, descriptor.name) === "ask") {
		const approved = await requestLocalApproval(context, descriptor, input, signal);
		if (!approved) {
			const failure: VehicleFailure = {
				code: "vehicle-safety-denied",
				category: "authorization",
				message: `${operationKey(descriptor)} was denied by the local /safety policy`,
				retryable: true,
			};
			publishOperationActivity("failed", identity, descriptor, { code: failure.code });
			throw new PiVehicleInvocationError(failure, manifest.name);
		}
	}

	let output: unknown;
	try {
		output = await client.invoke(descriptor.name, descriptor.version, input, baseInvocation);
	} catch (error) {
		const failure = sanitizedFailure(error);
		// The registry (once configureApprovals() is enabled there) records a
		// durable approval.requested event before ever failing this way -- a
		// caller always has a path forward via vehicle.approval.resolve, this
		// is just the optional local fast path attempting it automatically.
		if (failure.code !== "approval-required") {
			publishOperationActivity("failed", identity, descriptor, { code: failure.code });
			throw new PiVehicleInvocationError(failure, manifest.name);
		}
		const requestId = approvalRequestId(failure);
		// No requestId to act on, or no UI capable of asking -- the request
		// stays durably pending (an async/remote approver can still resolve it
		// later) rather than this call eagerly denying it on the caller's behalf.
		if (!requestId || !context.hasUI) {
			publishOperationActivity("failed", identity, descriptor, { code: failure.code });
			throw new PiVehicleInvocationError(failure, manifest.name);
		}

		const approved = await requestLocalApproval(context, descriptor, input, signal);
		let capability: string | undefined;
		try {
			const resolveOutput = (await client.invoke(
				VEHICLE_APPROVAL_RESOLVE_OPERATION_NAME,
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
		if (!capability) {
			publishOperationActivity("failed", identity, descriptor, { code: failure.code });
			throw new PiVehicleInvocationError(failure, manifest.name);
		}
		try {
			output = await client.invoke(descriptor.name, descriptor.version, input, { ...baseInvocation, approvalCapability: capability });
		} catch (retryError) {
			const retryFailure = sanitizedFailure(retryError);
			publishOperationActivity("failed", identity, descriptor, { code: retryFailure.code });
			throw new PiVehicleInvocationError(retryFailure, manifest.name);
		}
	}
	publishOperationActivity("completed", identity, descriptor);
	if (options.onInvoked) {
		try {
			await options.onInvoked({ descriptor, manifest, toolName, toolCallId, input, context }, output);
		} catch {
			// Best-effort: the invoke() itself already succeeded, so a broadcast failure
			// must never surface as a failed tool call.
		}
	}
	const followUp = options.interactiveFollowUps?.(descriptor);
	if (followUp) {
		const request: PiVehicleInvocationRequest = { descriptor, manifest, toolName, toolCallId, input, context, signal, onUpdate };
		const result = await followUp(request, output, client);
		if (result) return { content: [...result.content], details: { vehicle: identity, output: result.output ?? output } };
	}
	const content = extractVehicleContent(output) ?? [{ type: "text" as const, text: formatJson(output) }];
	return {
		content: [...content],
		details: { vehicle: identity, output },
	};
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
		executionMode: options.executionMode?.(descriptor),
		renderCall: overrides?.renderCall ?? ((args, theme, context) => renderVehicleCall(descriptor, args, theme, context)),
		renderResult:
			overrides?.renderResult ??
			((result, resultOptions, theme, context) => renderVehicleResult(descriptor, result, resultOptions, theme, context)),
		async execute(toolCallId, input, signal, onUpdate, context) {
			const result = await invokeVehicleOperation({
				client,
				manifest,
				descriptor,
				toolName,
				toolCallId,
				input,
				context,
				signal,
				onUpdate,
				options,
			});
			return { content: [...result.content], details: result.details };
		},
	};
}

/**
 * A live client.manifest() call is the source of truth whenever it succeeds --
 * on success, best-effort persists it to options.manifestCache for next time
 * (a failed cache write never fails registration). On failure, falls back to
 * the cached manifest if one exists (marking the result stale); with no cache
 * configured, or nothing cached yet, rethrows the original failure unchanged --
 * identical to registerVehicleTools' behavior before manifestCache existed.
 */
const DEFAULT_HANDSHAKE_ATTEMPTS = 4;
const DEFAULT_HANDSHAKE_INITIAL_DELAY_MS = 50;
const DEFAULT_HANDSHAKE_MAX_DELAY_MS = 500;
const DEFAULT_HANDSHAKE_GROW_FACTOR = 2.5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jittered exponential backoff, same shape as connectPushChannel's own reconnect delay (vehicle-client/daemon-client.ts): +/-20% jitter prevents several concurrent Pi sessions from retrying a just-restarted daemon in lockstep. */
function handshakeRetryDelayMs(attemptJustFailed: number, options: RegisterVehicleToolsHandshakeOptions | undefined): number {
	const initialDelayMs = options?.initialDelayMs ?? DEFAULT_HANDSHAKE_INITIAL_DELAY_MS;
	const maxDelayMs = options?.maxDelayMs ?? DEFAULT_HANDSHAKE_MAX_DELAY_MS;
	const growFactor = options?.growFactor ?? DEFAULT_HANDSHAKE_GROW_FACTOR;
	const raw = Math.min(initialDelayMs * growFactor ** (attemptJustFailed - 1), maxDelayMs);
	return raw * (0.8 + Math.random() * 0.4);
}

/**
 * Retries client.manifest() itself, bounded, before resolveManifestForRegistration ever falls
 * back to a stale cache or rethrows -- see RegisterVehicleToolsOptions.handshake for why this
 * exists. A transient failure (the daemon mid-restart) recovers here without ever touching the
 * cache-fallback/throw path below; only a failure that outlasts every attempt reaches it.
 */
async function fetchManifestWithHandshakeRetry(
	client: VehicleClient,
	handshake: RegisterVehicleToolsHandshakeOptions | undefined,
): Promise<VehicleManifest> {
	const attempts = Math.max(1, handshake?.attempts ?? DEFAULT_HANDSHAKE_ATTEMPTS);
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await client.manifest();
		} catch (error) {
			if (attempt === attempts) throw error;
			await sleep(handshakeRetryDelayMs(attempt, handshake));
		}
	}
	// Unreachable: the loop above always either returns or throws on its final attempt.
	throw new Error("fetchManifestWithHandshakeRetry: exhausted attempts without a terminal result");
}

async function resolveManifestForRegistration(
	client: VehicleClient,
	manifestCache: RegisterVehicleToolsOptions["manifestCache"],
	handshake: RegisterVehicleToolsOptions["handshake"],
): Promise<{ manifest: VehicleManifest; stale: boolean }> {
	try {
		const manifest = await fetchManifestWithHandshakeRetry(client, handshake);
		if (manifestCache) {
			try {
				await createAtomicJsonWriter({ fs: manifestCache.fs }).write(manifestCache.filePath, manifest);
			} catch {
				// Best-effort: a failed cache write must never fail a successful registration/refresh.
			}
		}
		return { manifest, stale: false };
	} catch (error) {
		if (!manifestCache) throw error;
		let cached: unknown;
		try {
			cached = await createAtomicJsonWriter({ fs: manifestCache.fs }).read(manifestCache.filePath);
		} catch {
			cached = undefined;
		}
		if (cached === undefined) throw error;
		return { manifest: cached as VehicleManifest, stale: true };
	}
}

/** Best-effort cache refresh after a real live fetch -- never used to mask a failed live fetch (refreshVehicleToolAvailability's whole point is verifying against the daemon, so it keeps throwing on failure, matching its behavior before manifestCache existed; pi-status-refresh's own safeRefresh already tolerates that). */
async function persistManifestCache(manifestCache: RegisterVehicleToolsOptions["manifestCache"], manifest: VehicleManifest): Promise<void> {
	if (!manifestCache) return;
	try {
		await createAtomicJsonWriter({ fs: manifestCache.fs }).write(manifestCache.filePath, manifest);
	} catch {
		// Best-effort: a failed cache write must never fail a successful refresh.
	}
}

export async function registerVehicleTools(
	pi: ExtensionAPI,
	client: VehicleClient,
	options: RegisterVehicleToolsOptions = {},
): Promise<RegisteredPiVehicle> {
	const { manifest, stale } = await resolveManifestForRegistration(client, options.manifestCache, options.handshake);
	const projected = projectedNames(manifest, options.toolName ?? defaultToolName);
	const runtime = tryExtensionRuntimeAction(() => pi.getAllTools());
	assertNamesAvailable(projected, runtime.status === "ready" ? runtime.value.map((tool) => tool.name) : []);

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
		permissionsSatisfied: permissionsSatisfied(descriptor.permissions, options.permissions),
		effect: descriptor.effect,
		safetyState: resolveSafetyState(manifest.name, descriptor, options),
	}));
	const shell = registerVehicleShell(pi, manifest, shellManagedTools(tools), options.shell);
	// Registered tools whose operation is currently unavailable (e.g. a
	// missing credential) or currently resolved to "blocked" (missing
	// permissions, or an explicit /safety override) are hidden from the LLM
	// from the very first registration -- registering them at all (rather
	// than skipping) keeps them ready to flip active later via
	// refreshVehicleToolAvailability, since Pi has no unregisterTool() to add
	// them back with afterward. During extension loading, definitions can be
	// registered but Pi's active-tool action methods are not ready yet; defer
	// only availability sync so renderers exist before transcript replay.
	const syncAvailability = () =>
		shell
			? applyVehicleShellActivation(pi, shell)
			: syncManagedActiveTools(
					pi,
					tools.map((tool) => tool.toolName),
					tools.filter((tool) => tool.available && tool.safetyState !== "blocked").map((tool) => tool.toolName),
				);
	if (runtime.status === "ready") {
		syncAvailability();
	} else {
		pi.on("session_start", syncAvailability);
	}
	contributeToSafetyRegistry(manifest, tools);

	return { manifest, tools, stale, ...(shell ? { shell } : {}) };
}

/** RegisteredPiVehicleTool's own available/blocked facts, narrowed to what vehicle-shell.ts needs -- keeps that file from importing this one's own (much larger) type. */
function shellManagedTools(tools: readonly RegisteredPiVehicleTool[]) {
	return tools.map((tool) => ({
		toolName: tool.toolName,
		operationName: tool.operationName,
		available: tool.available,
		blocked: tool.safetyState === "blocked",
	}));
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
	await persistManifestCache(options.manifestCache, manifest);
	const projected = projectedNames(manifest, options.toolName ?? defaultToolName);
	const known = new Set(registered.tools.map((tool) => operationKey({ name: tool.operationName, version: tool.operationVersion })));

	const newlyProjected = projected.filter(({ descriptor }) => !known.has(operationKey(descriptor)));
	if (newlyProjected.length > 0) {
		assertNamesAvailable(
			newlyProjected,
			guardExtensionRuntimeInitialized(() => pi.getAllTools()).map((tool) => tool.name),
		);
	}

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
			permissionsSatisfied: permissionsSatisfied(descriptor.permissions, options.permissions),
			effect: descriptor.effect,
			safetyState: resolveSafetyState(manifest.name, descriptor, options),
		});
	}

	if (registered.shell) {
		refreshVehicleShellManagedTools(registered.shell, shellManagedTools(tools));
		applyVehicleShellActivation(pi, registered.shell);
	} else {
		syncManagedActiveTools(
			pi,
			tools.map((tool) => tool.toolName),
			tools.filter((tool) => tool.available && tool.safetyState !== "blocked").map((tool) => tool.toolName),
		);
	}
	contributeToSafetyRegistry(manifest, tools);

	return { manifest, tools, stale: false, ...(registered.shell ? { shell: registered.shell } : {}) };
}

/**
 * One attempt's outcome, reported through `log` instead of the silent
 * return/bare-catch every consumer independently reimplemented (pi-tickets'
 * registerTicketsVehicle, pi-papyrus's registerNotesVehicle): `resolveClient`
 * returning undefined (no daemon target resolvable yet), `resolveClient`
 * throwing, or `registerVehicleTools` itself throwing all previously
 * vanished with zero diagnostic trail. `attempt`/`attempts` are 1-based and
 * inclusive, e.g. "2 of 5".
 */
export type VehicleReadyEvent =
	| { readonly kind: "client-unavailable"; readonly attempt: number; readonly attempts: number; readonly ctx: ExtensionContext }
	| {
			readonly kind: "client-resolution-failed";
			readonly attempt: number;
			readonly attempts: number;
			readonly error: unknown;
			readonly ctx: ExtensionContext;
	  }
	| {
			readonly kind: "registration-failed";
			readonly attempt: number;
			readonly attempts: number;
			readonly error: unknown;
			readonly ctx: ExtensionContext;
	  }
	| { readonly kind: "registered"; readonly attempt: number; readonly ctx: ExtensionContext }
	| { readonly kind: "exhausted"; readonly attempts: number; readonly ctx: ExtensionContext };

export interface VehicleReadyRetryOptions {
	/** Total attempts across the whole resolve+register sequence, including the first. Defaults to 6. */
	readonly attempts?: number;
	/** Delay before the second attempt. Defaults to 250ms. */
	readonly initialDelayMs?: number;
	/** No retry delay is ever allowed to exceed this. Defaults to 5000ms. */
	readonly maxDelayMs?: number;
	/** Multiplier applied to the delay after each failed attempt. Defaults to 2. */
	readonly growFactor?: number;
}

export interface RegisterVehicleToolsWhenReadyOptions extends RegisterVehicleToolsOptions {
	/** Every resolution/registration outcome, success or failure -- see VehicleReadyEvent. Omitting this restores today's silent behavior; a caller wanting the fix should always supply one (e.g. ctx.ui.notify or a structured logger). */
	readonly log?: (event: VehicleReadyEvent) => void;
	readonly retry?: VehicleReadyRetryOptions;
}

const DEFAULT_READY_RETRY_ATTEMPTS = 6;
const DEFAULT_READY_INITIAL_DELAY_MS = 250;
const DEFAULT_READY_MAX_DELAY_MS = 5_000;
const DEFAULT_READY_GROW_FACTOR = 2;

/** Same jittered exponential-backoff shape as handshakeRetryDelayMs, sized for the coarser-grained problem this solves: a daemon that hasn't started at all yet (seconds), not a manifest call mid-flight (milliseconds). */
function readyRetryDelayMs(attemptJustFailed: number, retry: VehicleReadyRetryOptions | undefined): number {
	const initialDelayMs = retry?.initialDelayMs ?? DEFAULT_READY_INITIAL_DELAY_MS;
	const maxDelayMs = retry?.maxDelayMs ?? DEFAULT_READY_MAX_DELAY_MS;
	const growFactor = retry?.growFactor ?? DEFAULT_READY_GROW_FACTOR;
	const raw = Math.min(initialDelayMs * growFactor ** (attemptJustFailed - 1), maxDelayMs);
	return raw * (0.8 + Math.random() * 0.4);
}

/**
 * Wraps `registerVehicleTools` with the one step it never owned: resolving
 * the daemon target and building a client in the first place. That step is
 * inherently consumer-specific (each daemon has its own handle file/target
 * resolution), which is why it was never centralized here before -- but the
 * failure handling around it (silent return on no target, bare catch on any
 * error, no later retry) was reimplemented identically by every consumer
 * and always dropped the failure on the floor. This centralizes that
 * handling once: every step logs through `log` instead of vanishing, and a
 * daemon that is merely slow to start gets bounded retries (see
 * VehicleReadyRetryOptions) instead of a permanent zero-tools outcome for
 * the rest of the session.
 *
 * Registers one `session_start` handler that kicks off the resolve+register
 * sequence in the background (never blocks session_start itself on a
 * multi-attempt backoff) and returns a promise that settles once the
 * sequence either succeeds or exhausts its attempts -- awaiting it is
 * optional, useful mainly for tests and for a caller that wants to know the
 * final outcome (e.g. to show one status line) without polling.
 *
 * Every other `RegisterVehicleToolsOptions` field (including the opt-in
 * `shell` activation mode) passes straight through to the eventual
 * `registerVehicleTools` call unchanged.
 */
export function registerVehicleToolsWhenReady(
	pi: ExtensionAPI,
	resolveClient: () => Promise<VehicleClient | undefined>,
	options: RegisterVehicleToolsWhenReadyOptions = {},
): Promise<RegisteredPiVehicle | undefined> {
	const attempts = Math.max(1, options.retry?.attempts ?? DEFAULT_READY_RETRY_ATTEMPTS);
	let settle!: (value: RegisteredPiVehicle | undefined) => void;
	const done = new Promise<RegisteredPiVehicle | undefined>((resolve) => {
		settle = resolve;
	});

	// `attempt` reuses one ctx captured at session_start across every retry, including across the
	// sleep between attempts -- a session replaced or reloaded during that window leaves `ctx`
	// stale (see extensions.md's "Session replacement lifecycle and footguns"), and a caller's own
	// `log` reading e.g. event.ctx.ui then throws. `attempt` itself runs fire-and-forget (see the
	// `void attempt(1, ctx)` call below), so any exception escaping `log` would otherwise surface
	// as an unhandled rejection that kills the whole host process, not just this one registration
	// attempt. safeLog swallows that failure so a broken/now-stale log callback can never do that,
	// and so every terminal branch still reaches its own settle() call.
	function safeLog(event: VehicleReadyEvent): void {
		try {
			options.log?.(event);
		} catch (error) {
			console.error(`registerVehicleToolsWhenReady: log callback threw for a "${event.kind}" event -- ${error}`);
		}
	}

	async function attempt(attemptNumber: number, ctx: ExtensionContext): Promise<void> {
		let client: VehicleClient | undefined;
		let resolutionFailed = false;
		try {
			client = await resolveClient();
		} catch (error) {
			safeLog({ kind: "client-resolution-failed", attempt: attemptNumber, attempts, error, ctx });
			resolutionFailed = true;
		}

		if (client) {
			try {
				const registered = await registerVehicleTools(pi, client, options);
				safeLog({ kind: "registered", attempt: attemptNumber, ctx });
				settle(registered);
				return;
			} catch (error) {
				safeLog({ kind: "registration-failed", attempt: attemptNumber, attempts, error, ctx });
			}
		} else if (!resolutionFailed) {
			safeLog({ kind: "client-unavailable", attempt: attemptNumber, attempts, ctx });
		}

		if (attemptNumber >= attempts) {
			safeLog({ kind: "exhausted", attempts, ctx });
			settle(undefined);
			return;
		}
		await sleep(readyRetryDelayMs(attemptNumber, options.retry));
		await attempt(attemptNumber + 1, ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		void attempt(1, ctx);
	});

	return done;
}
