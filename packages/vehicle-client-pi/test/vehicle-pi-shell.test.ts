import { describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import type { VehicleClient, VehicleInvocationOptions, VehicleManifest, VehicleManifestOperation } from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { refreshVehicleToolAvailability, registerVehicleTools } from "../src/vehicle-pi.ts";

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function operation(name: string, overrides: Partial<VehicleManifestOperation> = {}): VehicleManifestOperation {
	return {
		name,
		version: 1,
		description: `Run ${name}.`,
		inputSchema: { type: "object", properties: { value: { type: "string" } } },
		outputSchema: { type: "object" },
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
		available: true,
		...overrides,
	};
}

function manifest(operations: readonly VehicleManifestOperation[]): VehicleManifest {
	return { name: "test-vehicle", version: "1.0.0", description: "Test Vehicle.", operations };
}

class FakeClient implements VehicleClient {
	constructor(public value: VehicleManifest) {}
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
	const harness = createExtensionHarness(() => {});
	const pi: ExtensionAPI = {
		...harness.api,
		registerTool(tool: ToolDefinition) {
			harness.api.registerTool(tool);
			tools.push(tool);
		},
	} as ExtensionAPI;
	return { pi, tools, harness, activeTools: () => [...harness.activeTools] };
}

async function callTool(tools: ToolDefinition[], name: string, params: unknown) {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool.execute("call-1", params as never, undefined as never, undefined as never, { hasUI: false } as never);
}

describe("registerVehicleTools with shell activation", () => {
	it("boots with only the two meta-tools and the declared core operations active -- everything else registered but inactive", async () => {
		const { pi, harness } = fakePi();
		await registerVehicleTools(
			pi,
			new FakeClient(manifest([operation("tasks.create"), operation("tasks.depend"), operation("docs.list")])),
			{
				shell: { coreOperations: ["tasks.create"] },
			},
		);

		expect(harness.activeTools.sort()).toEqual(["tasks_create", "tools_list", "tools_man"].sort());
	});

	it("tools_list returns every operation as a one-liner, without activating any of them", async () => {
		const { pi, tools, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.create"), operation("docs.list")])), { shell: {} });

		const result = (await callTool(tools, "tools_list", {})) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("tasks.create -- Run tasks.create.");
		expect(result.content[0]?.text).toContain("docs.list -- Run docs.list.");
		expect(harness.activeTools).not.toContain("tasks_create");
		expect(harness.activeTools).not.toContain("docs_list");
	});

	it("tools_list filters by a query matched against name and description", async () => {
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.create"), operation("docs.list")])), { shell: {} });

		const result = (await callTool(tools, "tools_list", { query: "docs" })) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("docs.list");
		expect(result.content[0]?.text).not.toContain("tasks.create");
	});

	it("tools_man activates a discovered operation for the model's next turn", async () => {
		const { pi, tools, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.depend")])), { shell: {} });
		expect(harness.activeTools).not.toContain("tasks_depend");

		const result = (await callTool(tools, "tools_man", { names: ["tasks.depend"] })) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("tasks_depend (tasks.depend, v1)");
		expect(result.content[0]?.text).toContain("now callable as tasks_depend");
		expect(harness.activeTools).toContain("tasks_depend");
	});

	it("tools_man allows skip-ahead -- a name never surfaced by tools_list still activates", async () => {
		const { pi, tools, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.depend"), operation("docs.list")])), { shell: {} });

		await callTool(tools, "tools_man", { names: ["docs.list"] });
		expect(harness.activeTools).toContain("docs_list");
	});

	it("tools_man reports (and does not activate) an unknown operation name, pointing at tools_list", async () => {
		const { pi, tools, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.depend")])), { shell: {} });

		const result = (await callTool(tools, "tools_man", { names: ["nonexistent.op"] })) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("no such operation");
		expect(result.content[0]?.text).toContain("tools_list");
		expect(harness.activeTools).not.toContain("nonexistent_op");
	});

	it("a discovered operation decays and is deactivated after its TTL elapses unused", async () => {
		const { pi, tools, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.depend")])), { shell: { discoveredTtlTurns: 2 } });
		await callTool(tools, "tools_man", { names: ["tasks.depend"] });
		expect(harness.activeTools).toContain("tasks_depend");

		await harness.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] });
		expect(harness.activeTools).toContain("tasks_depend"); // 2 -> 1, still alive

		await harness.emit("turn_end", { turnIndex: 1, message: {}, toolResults: [] });
		expect(harness.activeTools).not.toContain("tasks_depend"); // 1 -> 0, evicted
	});

	it("calling a discovered operation resets its TTL instead of letting it decay while in use", async () => {
		const { pi, tools, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.depend")])), { shell: { discoveredTtlTurns: 2 } });
		await callTool(tools, "tools_man", { names: ["tasks.depend"] });

		await harness.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] }); // 2 -> 1
		await harness.emit("tool_execution_end", { toolCallId: "x", toolName: "tasks_depend", result: {}, isError: false });
		await harness.emit("turn_end", { turnIndex: 1, message: {}, toolResults: [] }); // called -> refreshed to 2

		await harness.emit("turn_end", { turnIndex: 2, message: {}, toolResults: [] }); // 2 -> 1
		expect(harness.activeTools).toContain("tasks_depend");
		await harness.emit("turn_end", { turnIndex: 3, message: {}, toolResults: [] }); // 1 -> 0
		expect(harness.activeTools).not.toContain("tasks_depend");
	});

	it("a core operation also decays and can be evicted if truly unused for long enough, not permanently pinned", async () => {
		const { pi, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.create")])), {
			shell: { coreOperations: ["tasks.create"], coreTtlTurns: 1 },
		});
		expect(harness.activeTools).toContain("tasks_create");

		await harness.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] });
		expect(harness.activeTools).not.toContain("tasks_create");
		expect(harness.activeTools).toContain("tools_list");
		expect(harness.activeTools).toContain("tools_man");
	});

	it("never activates an unavailable operation via tools_man", async () => {
		const { pi, tools, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.depend", { available: false })])), { shell: {} });

		const result = (await callTool(tools, "tools_man", { names: ["tasks.depend"] })) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("currently unavailable");
		expect(harness.activeTools).not.toContain("tasks_depend");
	});

	it("refreshVehicleToolAvailability re-seeds a core operation that just became available, matching initial registration", async () => {
		const { pi, harness } = fakePi();
		const client = new FakeClient(manifest([operation("tasks.create", { available: false })]));
		const registered = await registerVehicleTools(pi, client, { shell: { coreOperations: ["tasks.create"] } });
		expect(harness.activeTools).not.toContain("tasks_create");

		client.value = manifest([operation("tasks.create", { available: true })]);
		await refreshVehicleToolAvailability(pi, client, registered, { shell: { coreOperations: ["tasks.create"] } });
		expect(harness.activeTools).toContain("tasks_create");
	});

	it("refreshVehicleToolAvailability leaves an already-decaying discovered tool's TTL alone -- it doesn't reset every available tool active", async () => {
		const { pi, tools, harness } = fakePi();
		const client = new FakeClient(manifest([operation("tasks.depend")]));
		const registered = await registerVehicleTools(pi, client, { shell: { discoveredTtlTurns: 2 } });
		await callTool(tools, "tools_man", { names: ["tasks.depend"] });

		await harness.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] }); // 2 -> 1
		await refreshVehicleToolAvailability(pi, client, registered, { shell: { discoveredTtlTurns: 2 } });
		expect(harness.activeTools).toContain("tasks_depend"); // refresh must not re-grant full TTL

		await harness.emit("turn_end", { turnIndex: 1, message: {}, toolResults: [] }); // 1 -> 0
		expect(harness.activeTools).not.toContain("tasks_depend");
	});

	it("without options.shell, every available operation is active immediately -- today's behavior is unchanged", async () => {
		const { pi, harness } = fakePi();
		await registerVehicleTools(pi, new FakeClient(manifest([operation("tasks.create"), operation("tasks.depend")])), {});

		expect(harness.activeTools.sort()).toEqual(["tasks_create", "tasks_depend"].sort());
		expect(harness.activeTools).not.toContain("tools_list");
		expect(harness.activeTools).not.toContain("tools_man");
	});
});
