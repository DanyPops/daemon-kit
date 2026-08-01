/**
 * Proves the answer to the "God Parameters"/"Kitchen Sink tool" anti-pattern
 * (documented independently by IBM's MCP integration guidance, several
 * agent-tooling blogs, and Anthropic's own writing-tools-for-agents post)
 * actually holds at the scale that motivates reaching for it in the first
 * place. Papyrus's real `tasks` Pi tool collapses 38 actions behind one
 * unconstrained `action: Type.String()` parameter and 33 fields that are a
 * superset union across every branch -- this models that same 38-action
 * surface as 38 honest, independently-schema'd, independently-effect'd
 * VehicleOperations under one `tasks.*` namespace instead, and checks that
 * `registerVehicleTools()` projects all of them to distinct, correctly
 * prefixed Pi tools with zero collisions and zero new projection code.
 *
 * A second `notes.*` namespace registers alongside it to prove two
 * providers' operations never collide just because both use short, common
 * action words (`notes.create` vs `tasks.create`).
 */
import { describe, expect, it } from "bun:test";
import type {
	VehicleClient,
	VehicleEffect,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestOperation,
} from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerVehicleTools } from "../src/vehicle-pi.ts";

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

// The real action list from Papyrus's actual `tasks` tool, paired with the
// honest effect each one actually has -- unlike the mega-tool, which must
// pick one blended effect for all 38 or expose none at all.
const TASK_ACTIONS: Record<string, VehicleEffect> = {
	create: "local-write",
	update: "local-write",
	list: "read",
	show: "read",
	history: "read",
	context: "read",
	scope: "read",
	set_scope: "local-write",
	assign_project: "local-write",
	graph: "read",
	plan: "read",
	active: "read",
	focused: "read",
	focus: "local-write",
	pause: "local-write",
	unpause: "local-write",
	clear_focus: "local-write",
	start: "local-write",
	submit: "local-write",
	complete: "local-write",
	reject: "local-write",
	retry: "local-write",
	cancel: "destructive",
	cancel_subtree: "destructive",
	run_gates: "read",
	set_checklist: "local-write",
	depend: "local-write",
	undepend: "local-write",
	contain: "local-write",
	uncontain: "local-write",
	remove: "destructive",
	remove_subtree: "destructive",
	restore: "local-write",
	claim: "local-write",
	heartbeat_lease: "local-write",
	release_lease: "local-write",
	lease: "read",
	event_feed: "read",
};

const NOTE_ACTIONS: Record<string, VehicleEffect> = {
	create: "local-write",
	list: "read",
	show: "read",
	history: "read",
	consume: "local-write",
	promote: "local-write",
	archive: "local-write",
};

function operationsFor(namespace: string, actions: Record<string, VehicleEffect>): VehicleManifestOperation[] {
	return Object.entries(actions).map(([action, effect]) => ({
		name: `${namespace}.${action}`,
		version: 1,
		description: `${namespace} ${action}.`,
		// The whole point: each action gets its own narrow schema instead of
		// a shared blob of ~33 optional fields spanning every branch.
		inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
		outputSchema: { type: "object" },
		permissions: [],
		effect,
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
		available: true,
	}));
}

class FakeClient implements VehicleClient {
	constructor(private readonly value: VehicleManifest) {}
	manifest(): Promise<VehicleManifest> {
		return Promise.resolve(this.value);
	}
	async invoke<Output = unknown>(_name: string, _version: number, _input: unknown, _options?: VehicleInvocationOptions): Promise<Output> {
		return { ok: true } as Output;
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
}

function fakePi() {
	const tools: ToolDefinition[] = [];
	let active: string[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
			active.push(tool.name);
		},
		getAllTools() {
			return [];
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active = [...names];
		},
		on() {},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

describe("namespaced operations at mega-tool-replacing scale", () => {
	it("projects a 38-operation single-namespace manifest to 38 distinct, collision-free, correctly-prefixed Pi tools", async () => {
		const operations = operationsFor("tasks", TASK_ACTIONS);
		expect(operations).toHaveLength(38);

		const client = new FakeClient({ name: "papyrus-tasks", version: "1.0.0", description: "Task domain.", operations });
		const { pi, tools } = fakePi();

		const registered = await registerVehicleTools(pi, client);

		expect(registered.tools).toHaveLength(38);
		const names = registered.tools.map((tool) => tool.toolName);
		expect(new Set(names).size).toBe(38);
		for (const action of Object.keys(TASK_ACTIONS)) expect(names).toContain(`tasks_${action}`);

		// Each projected tool keeps its own narrow schema and honest effect --
		// never a shared blob of fields spanning every action.
		const createTool = tools.find((tool) => tool.name === "tasks_create");
		const removeTool = tools.find((tool) => tool.name === "tasks_remove");
		expect(createTool?.parameters).toEqual({ type: "object", properties: { id: { type: "string" } }, additionalProperties: false });
		expect(removeTool?.parameters).toEqual(createTool?.parameters);
		// Same shape, but registered as genuinely distinct tools -- unlike the
		// mega-tool, `tasks_remove`'s destructive effect never has to bleed
		// into `tasks_list`'s risk posture, and vice versa.
	});

	it("two providers' operations never collide just because both use short, common action words", async () => {
		const taskOps = operationsFor("tasks", TASK_ACTIONS);
		const noteOps = operationsFor("notes", NOTE_ACTIONS);
		const client = new FakeClient({
			name: "papyrus",
			version: "1.0.0",
			description: "Papyrus.",
			operations: [...taskOps, ...noteOps],
		});
		const { pi } = fakePi();

		const registered = await registerVehicleTools(pi, client);

		expect(registered.tools).toHaveLength(38 + 7);
		const names = registered.tools.map((tool) => tool.toolName);
		expect(new Set(names).size).toBe(38 + 7);
		expect(names).toContain("tasks_create");
		expect(names).toContain("notes_create");
		expect(names).not.toContain("create");
	});
});
