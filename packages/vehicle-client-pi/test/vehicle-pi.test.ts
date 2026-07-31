import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
	PiVehicleInvocationError,
	refreshVehicleToolAvailability,
	registerVehicleTools,
	type PiVehicleToolDetails,
} from "../src/vehicle-pi.ts";
import type {
	VehicleClient,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestOperation,
} from "@danypops/vehicle-core";
import { VehicleError } from "@danypops/vehicle-core";

const limits = {
	defaultTimeoutMs: 1_000,
	maxTimeoutMs: 5_000,
	maxRequestBytes: 1_024,
	maxResponseBytes: 1_024,
};

function operation(
	name: string,
	version = 1,
	overrides: Partial<VehicleManifestOperation> = {},
): VehicleManifestOperation {
	return {
		name,
		version,
		description: `Run ${name}.`,
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		},
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

class FakeClient implements VehicleClient {
	readonly calls: Array<{
		name: string;
		version: number;
		input: unknown;
		options: VehicleInvocationOptions | undefined;
	}> = [];
	closed = false;
	result: unknown = { ok: true };
	error?: unknown;

	constructor(public value: VehicleManifest) {}

	manifest(): Promise<VehicleManifest> {
		return Promise.resolve(this.value);
	}

	async invoke<Output = unknown>(
		name: string,
		version: number,
		input: unknown,
		options?: VehicleInvocationOptions,
	): Promise<Output> {
		this.calls.push({ name, version, input, options });
		options?.onProgress?.({ phase: "half" });
		if (this.error) throw this.error;
		return this.result as Output;
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}
}

function manifest(operations: readonly VehicleManifestOperation[]): VehicleManifest {
	return { name: "test-vehicle", version: "1.0.0", description: "Test Vehicle.", operations };
}

function fakePi(existingNames: string[] = []) {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	let active = [...existingNames];
	let setCalls = 0;
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
			active.push(tool.name);
		},
		getAllTools() {
			return existingNames.map((name) => ({ name }));
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			setCalls++;
			active = [...names];
		},
		on(name: string, handler: (...args: never[]) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers, activeTools: () => [...active], setCallCount: () => setCalls };
}

async function execute(
	tool: ToolDefinition,
	input: unknown,
	signal?: AbortSignal,
	onUpdate?: (update: unknown) => void,
) {
	return tool.execute("pi-call-1", input as never, signal, onUpdate as never, {
		sessionManager: { getSessionId: () => "session-1" },
	} as never);
}

describe("registerVehicleTools", () => {
	it("projects descriptor schemas and invokes the exact Vehicle operation", async () => {
		const descriptor = operation("issues.search");
		const client = new FakeClient(manifest([descriptor]));
		const { pi, tools } = fakePi();

		const registered = await registerVehicleTools(pi, client);

		expect(registered.tools).toEqual([
			{ toolName: "issues_search", operationName: "issues.search", operationVersion: 1, available: true },
		]);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.description).toBe(descriptor.description);
		expect(JSON.parse(JSON.stringify(tools[0]?.parameters))).toEqual(descriptor.inputSchema);
		expect(Check(tools[0]!.parameters, { value: "bug" })).toBe(true);
		expect(Check(tools[0]!.parameters, { value: 1 })).toBe(false);

		const result = await execute(tools[0]!, { value: "bug" });
		expect(client.calls[0]).toMatchObject({
			name: "issues.search",
			version: 1,
			input: { value: "bug" },
			options: { operationId: "pi-call-1", correlationId: "session-1" },
		});
		expect(result.content).toEqual([{ type: "text", text: '{\n  "ok": true\n}' }]);
		expect((result.details as PiVehicleToolDetails).vehicle).toEqual({
			name: "test-vehicle",
			version: "1.0.0",
			operation: "issues.search",
			operationVersion: 1,
			toolCallId: "pi-call-1",
		});
	});

	it("suffixes multiple operation versions and rejects projected or existing name collisions atomically", async () => {
		const versions = new FakeClient(manifest([operation("issues.search", 1), operation("issues.search", 2)]));
		const projected = fakePi();
		await registerVehicleTools(projected.pi, versions);
		expect(projected.tools.map((tool) => tool.name)).toEqual(["issues_search_v1", "issues_search_v2"]);

		const collisionPi = fakePi();
		await expect(
			registerVehicleTools(
				collisionPi.pi,
				new FakeClient(manifest([operation("issues.search"), operation("issues_search")])),
			),
		).rejects.toThrow("collision");
		expect(collisionPi.tools).toHaveLength(0);

		const existing = fakePi(["issues_search"]);
		await expect(
			registerVehicleTools(existing.pi, new FakeClient(manifest([operation("issues.search")]))),
		).rejects.toThrow("already registered");
		expect(existing.tools).toHaveLength(0);
	});

	it("forwards permissions, principal, cancellation, keyed idempotency, and progress", async () => {
		const descriptor = operation("files.write", 1, {
			permissions: ["workspace:write"],
			effect: "local-write",
			idempotency: { mode: "keyed", retentionMs: 60_000 },
		});
		const client = new FakeClient(manifest([descriptor]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, {
			permissions: ["workspace:write"],
			principal: { id: "pi-user" },
		});
		const controller = new AbortController();
		const updates: unknown[] = [];

		await execute(tools[0]!, { value: "content" }, controller.signal, (update) => updates.push(update));

		expect(client.calls[0]?.options).toMatchObject({
			permissions: ["workspace:write"],
			principal: { id: "pi-user" },
			idempotencyKey: "pi-call-1",
			signal: controller.signal,
		});
		expect(updates).toEqual([
			{
				content: [{ type: "text", text: '{\n  "phase": "half"\n}' }],
				details: expect.objectContaining({ progress: { phase: "half" } }),
			},
		]);
	});

	it("requires capability-backed approval for destructive and open-world effects", async () => {
		for (const effect of ["destructive", "open-world"] as const) {
			const client = new FakeClient(manifest([operation(`risk.${effect}`, 1, { effect })]));
			const denied = fakePi();
			await registerVehicleTools(denied.pi, client);
			await expect(execute(denied.tools[0]!, { value: "go" })).rejects.toThrow("approval capability");
			expect(client.calls).toHaveLength(0);

			const allowed = fakePi();
			await registerVehicleTools(allowed.pi, client, {
				resolveInvocation: () => ({ approvalCapability: "signed-capability" }),
			});
			await execute(allowed.tools[0]!, { value: "go" });
			expect(client.calls[0]?.options?.approvalCapability).toBe("signed-capability");
		}
	});

	it("passes resolved invocation metadata without allowing identity or signal replacement", async () => {
		const client = new FakeClient(manifest([operation("meta.test")]));
		const { pi, tools } = fakePi();
		const otherSignal = new AbortController().signal;
		await registerVehicleTools(pi, client, {
			resolveInvocation: ({ descriptor, toolCallId }) => ({
				operationId: "wrong",
				correlationId: `${descriptor.name}:${toolCallId}`,
				signal: otherSignal,
				expectedRevision: "rev-2",
			}),
		});
		const actualSignal = new AbortController().signal;
		await execute(tools[0]!, { value: "go" }, actualSignal);
		expect(client.calls[0]?.options).toMatchObject({
			operationId: "pi-call-1",
			correlationId: "meta.test:pi-call-1",
			signal: actualSignal,
			expectedRevision: "rev-2",
		});
	});

	it("sanitizes Vehicle failures and optionally closes an owned client on session shutdown", async () => {
		const client = new FakeClient(manifest([operation("fail.test")]));
		client.error = new VehicleError("upstream-busy", "Provider is busy", {
			category: "unavailable",
			retryable: true,
			operationId: "remote-op",
			cause: new Error("secret internal cause"),
		});
		const { pi, tools, handlers } = fakePi();
		await registerVehicleTools(pi, client, { closeClientOnSessionShutdown: true });

		try {
			await execute(tools[0]!, { value: "go" });
			throw new Error("expected invocation failure");
		} catch (error) {
			expect(error).toBeInstanceOf(PiVehicleInvocationError);
			expect((error as PiVehicleInvocationError).failure).toMatchObject({
				code: "upstream-busy",
				category: "unavailable",
				retryable: true,
			});
			expect(String(error)).not.toContain("secret internal cause");
		}

		await handlers.get("session_shutdown")?.();
		expect(client.closed).toBe(true);
	});

	it("registers a currently-unavailable operation's tool but never activates it, so the LLM never sees it", async () => {
		const client = new FakeClient(
			manifest([
				operation("issues.search"),
				operation("jira.search", 1, { available: false, unavailableReason: "no Jira credential configured" }),
			]),
		);
		const { pi, tools, activeTools } = fakePi();

		const registered = await registerVehicleTools(pi, client);

		expect(tools.map((tool) => tool.name).sort()).toEqual(["issues_search", "jira_search"]);
		expect(activeTools().sort()).toEqual(["issues_search"]);
		expect(registered.tools).toEqual([
			{ toolName: "issues_search", operationName: "issues.search", operationVersion: 1, available: true },
			{ toolName: "jira_search", operationName: "jira.search", operationVersion: 1, available: false },
		]);
	});

	it("never disables an unrelated already-active tool while curating its own", async () => {
		const client = new FakeClient(manifest([operation("issues.search", 1, { available: false })]));
		const { pi, activeTools } = fakePi(["read", "edit"]);

		await registerVehicleTools(pi, client);

		expect(activeTools().sort()).toEqual(["edit", "read"]);
	});

	it("turns Pi's cryptic \"Extension runtime not initialized\" error (calling registerVehicleTools from the top-level factory body) into a clear, actionable one", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		const { pi } = fakePi();
		const notInitialized = new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
		const brokenPi = {
			...pi,
			getAllTools: () => {
				throw notInitialized;
			},
		} as unknown as ExtensionAPI;

		await expect(registerVehicleTools(brokenPi, client)).rejects.toThrow(/session_start/);
		try {
			await registerVehicleTools(brokenPi, client);
		} catch (error) {
			expect((error as Error).cause).toBe(notInitialized);
		}
	});

	it("sets promptSnippet so Pi's \"Available tools\" system-prompt section lists the tool -- omitted entirely otherwise, confirmed live", async () => {
		const descriptor = operation("issues.search");
		const client = new FakeClient(manifest([descriptor]));
		const { pi, tools } = fakePi();

		await registerVehicleTools(pi, client);

		expect(tools[0]?.promptSnippet).toBe(descriptor.description);
	});

	it("wires the generic Vehicle renderer by default, so a projected tool never falls back to Pi's raw-JSON rendering", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		const { pi, tools } = fakePi();

		await registerVehicleTools(pi, client);

		expect(tools[0]?.renderCall).toBeDefined();
		expect(tools[0]?.renderResult).toBeDefined();
	});

	it("lets a per-operation renderers override win over the generic default", async () => {
		const client = new FakeClient(manifest([operation("issues.search"), operation("issues.close")]));
		const { pi, tools } = fakePi();
		const customRenderCall = () => ({ render: () => ["custom"], invalidate: () => {} });

		await registerVehicleTools(pi, client, {
			renderers: (descriptor) => (descriptor.name === "issues.search" ? { renderCall: customRenderCall as never } : undefined),
		});

		const search = tools.find((tool) => tool.name === "issues_search");
		const close = tools.find((tool) => tool.name === "issues_close");
		expect(search?.renderCall).toBe(customRenderCall as never);
		expect(close?.renderCall).toBeDefined();
		expect(close?.renderCall).not.toBe(customRenderCall as never);
	});

	it("falls back to raw formatted JSON for the model when the output carries no content blocks", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.result = { total: 2 };
		const { pi, tools } = fakePi();

		await registerVehicleTools(pi, client);
		const result = await execute(tools[0]!, { value: "bug" });

		expect(result.content).toEqual([{ type: "text", text: '{\n  "total": 2\n}' }]);
	});

	it("sends an operation's own content blocks to the model instead of raw JSON, when its output carries them", async () => {
		const client = new FakeClient(manifest([operation("skills.run"), operation("issues.search")]));
		client.result = {
			runId: "run-1",
			created: { tasks: ["t1", "t2"] },
			content: [{ type: "text", text: "Created run run-1: 2 task(s)." }],
		};
		const { pi, tools } = fakePi();

		await registerVehicleTools(pi, client);

		const run = tools.find((tool) => tool.name === "skills_run")!;
		const search = tools.find((tool) => tool.name === "issues_search")!;

		const runResult = await execute(run, { value: "x" });
		expect(runResult.content).toEqual([{ type: "text", text: "Created run run-1: 2 task(s)." }]);

		// An operation whose output carries no content field falls back to raw JSON, same as before --
		// the convention is opt-in per operation, not a global behavior change.
		client.result = { ok: true };
		const searchResult = await execute(search, { value: "bug" });
		expect(searchResult.content).toEqual([{ type: "text", text: '{\n  "ok": true\n}' }]);
	});

	it("falls back to raw JSON when an output's content field is present but malformed, rather than forwarding partial blocks", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.result = { total: 2, content: [{ type: "text" }, "not a block"] };
		const { pi, tools } = fakePi();

		await registerVehicleTools(pi, client);
		const result = await execute(tools[0]!, { value: "bug" });

		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(client.result, null, 2) }]);
	});

	it("content blocks never replace details.output or the human renderCall/renderResult", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.result = { total: 2, content: [{ type: "text", text: "Found 2 issues." }] };
		const { pi, tools } = fakePi();

		await registerVehicleTools(pi, client);
		const result = await execute(tools[0]!, { value: "bug" });

		expect((result.details as PiVehicleToolDetails).output).toEqual(client.result);
		expect(tools[0]?.renderCall).toBeDefined();
		expect(tools[0]?.renderResult).toBeDefined();
	});
});

describe("refreshVehicleToolAvailability", () => {
	it("activates a tool whose operation just became available, without re-registering it", async () => {
		const client = new FakeClient(manifest([operation("jira.search", 1, { available: false })]));
		const { pi, tools, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, client);
		expect(activeTools()).toEqual([]);

		client.value = manifest([operation("jira.search", 1, { available: true })]);
		const refreshed = await refreshVehicleToolAvailability(pi, client, registered);

		expect(tools).toHaveLength(1); // still exactly one registerTool call ever
		expect(activeTools()).toEqual(["jira_search"]);
		expect(refreshed.tools).toEqual([
			{ toolName: "jira_search", operationName: "jira.search", operationVersion: 1, available: true },
		]);
	});

	it("deactivates a tool whose operation just became unavailable", async () => {
		const client = new FakeClient(manifest([operation("jira.search", 1, { available: true })]));
		const { pi, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, client);
		expect(activeTools()).toEqual(["jira_search"]);

		client.value = manifest([operation("jira.search", 1, { available: false, unavailableReason: "credential removed" })]);
		const refreshed = await refreshVehicleToolAvailability(pi, client, registered);

		expect(activeTools()).toEqual([]);
		expect(refreshed.tools[0]?.available).toBe(false);
	});

	it("registers a genuinely new operation that appeared in a later manifest", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		const { pi, tools, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, client);

		client.value = manifest([operation("issues.search"), operation("issues.create")]);
		const refreshed = await refreshVehicleToolAvailability(pi, client, registered);

		expect(tools.map((tool) => tool.name).sort()).toEqual(["issues_create", "issues_search"]);
		expect(activeTools().sort()).toEqual(["issues_create", "issues_search"]);
		expect(refreshed.tools.map((tool) => tool.operationName).sort()).toEqual(["issues.create", "issues.search"]);
	});

	it("a no-op refresh (nothing changed) never calls setActiveTools", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		const { pi, setCallCount } = fakePi();
		const registered = await registerVehicleTools(pi, client);

		const before = setCallCount();
		await refreshVehicleToolAvailability(pi, client, registered);
		expect(setCallCount()).toBe(before);
	});
});
