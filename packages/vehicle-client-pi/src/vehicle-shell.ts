import type { JsonSchema, VehicleManifest, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { syncManagedActiveTools } from "./pi-tool-availability.js";

/**
 * A decaying-TTL cache over Pi's active-tool set, turn-scoped. Every tracked tool name carries a
 * current and a starting TTL (in turns); a tool actually called during a turn is refreshed back to
 * its own starting value, everything else decrements by one -- reaching zero evicts it (removed
 * from the tracker; the underlying Pi tool stays registered, just inactive until re-seeded).
 *
 * Deliberately name-keyed and Pi-agnostic: this file never touches ExtensionAPI directly, so its
 * decay/refresh logic is testable as a pure state machine.
 */
export class VehicleShellTtlTracker {
	private readonly entries = new Map<string, { current: number; readonly starting: number }>();
	private readonly calledThisTurn = new Set<string>();

	/** Starts (or re-activates) tracking a tool name at the given starting TTL -- also used to
	 * refresh an already-tracked tool back to full TTL (e.g. a repeat tools_man call). */
	seed(toolName: string, startingTtl: number): void {
		this.entries.set(toolName, { current: startingTtl, starting: startingTtl });
	}

	/** Marks a tracked tool as called this turn -- a no-op for a name this tracker isn't tracking
	 * (the two meta-tools themselves, or any tool outside this Vehicle's own managed set). */
	recordCall(toolName: string): void {
		if (this.entries.has(toolName)) this.calledThisTurn.add(toolName);
	}

	/**
	 * Applies one turn's decay: a tool called this turn resets to its own starting TTL (stays
	 * warm, not just "not yet decremented"); every other tracked tool decrements by one. A tool
	 * that reaches zero is evicted (removed from tracking) and reported in the returned list.
	 */
	tick(): { readonly evicted: readonly string[] } {
		const evicted: string[] = [];
		for (const [toolName, entry] of this.entries) {
			if (this.calledThisTurn.has(toolName)) {
				entry.current = entry.starting;
				continue;
			}
			entry.current -= 1;
			if (entry.current <= 0) evicted.push(toolName);
		}
		for (const toolName of evicted) this.entries.delete(toolName);
		this.calledThisTurn.clear();
		return { evicted };
	}

	/** Every currently-tracked (non-evicted) tool name -- the TTL-managed subset of the active set. */
	trackedNames(): readonly string[] {
		return [...this.entries.keys()];
	}

	isTracked(toolName: string): boolean {
		return this.entries.has(toolName);
	}
}

/** The NAME section of a real man page: one line, no wrapping, safe to list alongside dozens of others. */
export function formatOperationOneLiner(descriptor: VehicleOperationDescriptor): string {
	return `${descriptor.name} -- ${descriptor.description}`;
}

/** Case-insensitive substring match against the same text formatOperationOneLiner shows -- apropos's own matching model (name + description), not a fuzzy/ranked search. */
export function matchesShellQuery(descriptor: VehicleOperationDescriptor, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return true;
	return `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(needle);
}

function formatSchemaProperties(schema: JsonSchema): string[] {
	const properties = schema.properties;
	if (typeof properties !== "object" || properties === null) return [];
	const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((v) => typeof v === "string") : []);
	return Object.entries(properties as Record<string, unknown>).map(([key, raw]) => {
		const prop = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
		const type = typeof prop.type === "string" ? prop.type : "any";
		const desc = typeof prop.description === "string" ? prop.description : "";
		const marker = required.has(key) ? "required" : "optional";
		return desc.length > 0 ? `  - ${key} (${type}, ${marker}): ${desc}` : `  - ${key} (${type}, ${marker})`;
	});
}

/** The full man page for one operation -- description, parameters, and the safety-relevant facts
 * (permissions/effect/idempotency) a model needs before deciding whether and how to call it. */
export function formatOperationManPage(descriptor: VehicleOperationDescriptor, toolName: string): string {
	const lines = [
		`${toolName} (${descriptor.name}, v${descriptor.version})`,
		descriptor.description,
		"",
		`effect: ${descriptor.effect}`,
		`permissions: ${descriptor.permissions.length > 0 ? descriptor.permissions.join(", ") : "none"}`,
		`idempotency: ${descriptor.idempotency.mode}`,
	];
	const properties = formatSchemaProperties(descriptor.inputSchema);
	lines.push("", "parameters:");
	lines.push(...(properties.length > 0 ? properties : ["  (none)"]));
	return lines.join("\n");
}

const DEFAULT_LIST_TOOL_NAME = "tools_list";
const DEFAULT_MAN_TOOL_NAME = "tools_man";
/** Illustrative starting points, not load-bearing constants -- tune from real usage (see the
 * Vehicle Shell design discussion this implements). */
const DEFAULT_CORE_TTL_TURNS = 10;
const DEFAULT_DISCOVERED_TTL_TURNS = 3;

/** The subset of a registered Pi tool's own bookkeeping the shell needs to decide what's
 * activatable -- deliberately narrower than vehicle-pi.ts's own RegisteredPiVehicleTool so this
 * file never has to import from (and create a cycle with) vehicle-pi.ts. */
export interface VehicleShellManagedTool {
	readonly toolName: string;
	readonly operationName: string;
	readonly available: boolean;
	readonly blocked: boolean;
}

export interface VehicleShellOptions {
	/** Operation names (VehicleOperationDescriptor.name, e.g. "tasks.create") that boot active with
	 * coreTtlTurns, needing no tools_man call. Everything else boots inactive, reachable only via
	 * tools_man. Domain-agnostic on purpose -- this package never names a specific consumer's
	 * operations; the consumer supplies its own list. */
	readonly coreOperations?: readonly string[];
	/** Starting TTL, in turns, for a core operation. Default 10 -- illustrative, tune from usage. */
	readonly coreTtlTurns?: number;
	/** Starting TTL, in turns, for an operation activated via tools_man. Default 3 -- illustrative. */
	readonly discoveredTtlTurns?: number;
	/** Pi tool name for the list meta-tool. Default "tools_list". */
	readonly listToolName?: string;
	/** Pi tool name for the man meta-tool. Default "tools_man". */
	readonly manToolName?: string;
}

export interface VehicleShellHandle {
	readonly tracker: VehicleShellTtlTracker;
	readonly listToolName: string;
	readonly manToolName: string;
	/** Live, mutable view of this Vehicle's own managed tools -- refreshVehicleShellManagedTools
	 * keeps this current across a refreshVehicleToolAvailability call, since the per-turn decay
	 * handler and the man-page tool both close over this same handle rather than a stale snapshot. */
	managedTools: readonly VehicleShellManagedTool[];
	readonly coreOperationNames: ReadonlySet<string>;
	/** Starting TTL a core operation is (re-)seeded with -- kept on the handle so a later refresh
	 * can seed a core operation that just became available the same way initial registration did. */
	readonly coreTtlTurns: number;
}

/**
 * Updates a handle's managed-tool bookkeeping after a fresh availability check (e.g. a credential
 * became available, or a /safety override changed). A core operation that just became available
 * and isn't currently tracked is (re-)seeded fresh, matching what initial registration would have
 * done for it -- every other tracked tool (core or discovered) is left exactly as the decay cycle
 * already has it; "core" only ever means "seeded generously," never "exempt from decay" (see
 * desiredShellActiveNames, which reads tracker membership alone, not coreOperationNames, for who's
 * currently active).
 */
export function refreshVehicleShellManagedTools(handle: VehicleShellHandle, managedTools: readonly VehicleShellManagedTool[]): void {
	handle.managedTools = managedTools;
	for (const tool of managedTools) {
		if (handle.coreOperationNames.has(tool.operationName) && tool.available && !tool.blocked && !handle.tracker.isTracked(tool.toolName)) {
			handle.tracker.seed(tool.toolName, handle.coreTtlTurns);
		}
	}
}

/** Every Pi tool name this handle could ever legitimately activate -- the full `managed` superset syncManagedActiveTools requires. */
function allManagedNames(handle: VehicleShellHandle): string[] {
	return [...handle.managedTools.map((tool) => tool.toolName), handle.listToolName, handle.manToolName];
}

/**
 * The active set a shell handle wants right now: its two meta-tools (always active), its core
 * operations that are currently available and unblocked, and whatever tools_man has activated
 * that hasn't yet decayed out -- re-filtered against current availability so a tool that became
 * unavailable/blocked since it was seeded doesn't stay active just because its TTL hasn't hit zero.
 */
export function desiredShellActiveNames(handle: VehicleShellHandle): string[] {
	const byToolName = new Map(handle.managedTools.map((tool) => [tool.toolName, tool]));
	const tracked = handle.tracker.trackedNames().filter((toolName) => {
		const tool = byToolName.get(toolName);
		return tool?.available === true && !tool.blocked;
	});
	return [...new Set([handle.listToolName, handle.manToolName, ...tracked])];
}

function applyShellActivation(pi: ExtensionAPI, handle: VehicleShellHandle): void {
	syncManagedActiveTools(pi, allManagedNames(handle), desiredShellActiveNames(handle));
}

function createToolsListTool(listToolName: string, manifest: VehicleManifest): ToolDefinition {
	return {
		name: listToolName,
		label: "List Tools",
		description: `Lists ${manifest.name}'s available operations by name, one line each (name -- description). Optionally filter by a keyword matched against the name and description. Use ${DEFAULT_MAN_TOOL_NAME} on a name from this list (or any name you already know) to see its full parameters and make it callable.`,
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Keyword to filter by (matched against operation name and description); omit to list everything." }),
			),
		}),
		async execute(_toolCallId, params) {
			const query = (params as { query?: string }).query ?? "";
			const matches = manifest.operations.filter((descriptor) => matchesShellQuery(descriptor, query));
			const text =
				matches.length === 0
					? `No operations matched "${query}".`
					: matches.map((descriptor) => formatOperationOneLiner(descriptor)).join("\n");
			return {
				content: [{ type: "text", text }],
				details: { operations: matches.map((descriptor) => ({ name: descriptor.name, description: descriptor.description })) },
			};
		},
	};
}

function createToolsManTool(
	pi: ExtensionAPI,
	manToolName: string,
	manifest: VehicleManifest,
	handle: VehicleShellHandle,
	discoveredTtlTurns: number,
): ToolDefinition {
	return {
		name: manToolName,
		label: "Tool Manual",
		description: `Shows full documentation for one or more of ${manifest.name}'s operations by exact name (as seen from ${DEFAULT_LIST_TOOL_NAME} or already known) and makes each one callable starting next turn. A name doesn't need to have been listed first.`,
		parameters: Type.Object({
			names: Type.Array(Type.String(), { description: 'Exact operation name(s), e.g. "tasks.create".', minItems: 1 }),
		}),
		async execute(_toolCallId, params) {
			const names = (params as { names: string[] }).names;
			const byOperationName = new Map(handle.managedTools.map((tool) => [tool.operationName, tool]));
			const pages = names.map((name) => {
				const descriptor = manifest.operations.find((op) => op.name === name);
				const managed = byOperationName.get(name);
				if (!descriptor || !managed) return `${name}: no such operation. Use ${DEFAULT_LIST_TOOL_NAME} to browse available names.`;
				if (!managed.available) return `${name}: currently unavailable (${DEFAULT_MAN_TOOL_NAME} cannot activate it right now).`;
				if (managed.blocked) return `${name}: blocked by the current safety policy -- not activatable.`;
				handle.tracker.seed(managed.toolName, discoveredTtlTurns);
				return `${formatOperationManPage(descriptor, managed.toolName)}\n\n(now callable as ${managed.toolName})`;
			});
			applyShellActivation(pi, handle);
			return { content: [{ type: "text", text: pages.join("\n\n---\n\n") }], details: {} };
		},
	};
}

/**
 * Registers the two always-on meta-tools (tools_list, tools_man) and wires the decaying-TTL
 * activation cycle: a core operation (per options.coreOperations) boots active; every other
 * operation boots inactive, reachable via tools_man; each turn, unused active tools decay and
 * eventually get deactivated (not unregistered -- Pi has no unregisterTool()), while a tool
 * actually called that turn stays fully warm. Returns undefined (no-op, today's all-active
 * behavior applies) when options is omitted -- opt-in only, per this package's own convention for
 * a change that could alter an existing consumer's visible tool surface.
 */
export function registerVehicleShell(
	pi: ExtensionAPI,
	manifest: VehicleManifest,
	managedTools: readonly VehicleShellManagedTool[],
	options: VehicleShellOptions | undefined,
): VehicleShellHandle | undefined {
	if (!options) return undefined;
	const discoveredTtlTurns = options.discoveredTtlTurns ?? DEFAULT_DISCOVERED_TTL_TURNS;
	const handle: VehicleShellHandle = {
		tracker: new VehicleShellTtlTracker(),
		listToolName: options.listToolName ?? DEFAULT_LIST_TOOL_NAME,
		manToolName: options.manToolName ?? DEFAULT_MAN_TOOL_NAME,
		managedTools,
		coreOperationNames: new Set(options.coreOperations ?? []),
		coreTtlTurns: options.coreTtlTurns ?? DEFAULT_CORE_TTL_TURNS,
	};

	for (const tool of managedTools) {
		if (handle.coreOperationNames.has(tool.operationName) && tool.available && !tool.blocked)
			handle.tracker.seed(tool.toolName, handle.coreTtlTurns);
	}

	pi.registerTool(createToolsListTool(handle.listToolName, manifest));
	pi.registerTool(createToolsManTool(pi, handle.manToolName, manifest, handle, discoveredTtlTurns));

	pi.on("tool_execution_end", (event) => {
		const toolName = (event as { toolName?: unknown }).toolName;
		if (typeof toolName === "string") handle.tracker.recordCall(toolName);
	});
	pi.on("turn_end", () => {
		handle.tracker.tick();
		applyShellActivation(pi, handle);
	});

	return handle;
}

/** Applies (or re-applies, e.g. once the runtime is ready after session_start) the shell's
 * current desired active set -- the shell-mode counterpart of registerVehicleTools' own
 * syncAvailability closure for the non-shell path. */
export function applyVehicleShellActivation(pi: ExtensionAPI, handle: VehicleShellHandle): void {
	applyShellActivation(pi, handle);
}
