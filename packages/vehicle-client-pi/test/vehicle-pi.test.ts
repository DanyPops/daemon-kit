import { afterEach, describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import type {
	AtomicJsonFsAdapter,
	VehicleClient,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestOperation,
} from "@danypops/vehicle-core";
import { VehicleError } from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { registerActivityBroker, unregisterActivityBroker, type VehicleActivityEvent } from "../src/activity-broker.ts";
import {
	invokeVehicleOperation,
	PiVehicleInvocationError,
	type PiVehicleToolDetails,
	refreshVehicleToolAvailability,
	registerVehicleTools,
} from "../src/vehicle-pi.ts";
import { VehicleSafetyPolicyStore } from "../src/vehicle-safety.ts";
import { __resetVehicleSafetyRegistryForTests, listVehicleSafetyContributors } from "../src/vehicle-safety-registry.ts";

const limits = {
	defaultTimeoutMs: 1_000,
	maxTimeoutMs: 5_000,
	maxRequestBytes: 1_024,
	maxResponseBytes: 1_024,
};

function operation(name: string, version = 1, overrides: Partial<VehicleManifestOperation> = {}): VehicleManifestOperation {
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
	/** Simulates the daemon being unreachable: manifest() rejects with this instead of resolving `value`. */
	manifestError?: unknown;

	constructor(public value: VehicleManifest) {}

	manifest(): Promise<VehicleManifest> {
		if (this.manifestError) return Promise.reject(this.manifestError);
		return Promise.resolve(this.value);
	}

	async invoke<Output = unknown>(name: string, version: number, input: unknown, options?: VehicleInvocationOptions): Promise<Output> {
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

/**
 * tools is a real, stably-referenced mutable array (not a getter) so every one of this file's
 * `const { pi, tools } = fakePi()` destructures keeps seeing later pushes -- matching the
 * pre-migration hand-rolled fake's own semantics exactly.
 */
function fakePi(existingNames: string[] = []) {
	const tools: ToolDefinition[] = [];
	const harness = createExtensionHarness(() => {}, { existingTools: existingNames });
	const pi: ExtensionAPI = {
		...harness.api,
		registerTool(tool: ToolDefinition) {
			harness.api.registerTool(tool);
			tools.push(tool);
		},
	} as ExtensionAPI;
	return {
		pi,
		tools,
		activeTools: () => [...harness.activeTools],
		setCallCount: () => harness.activeToolsHistory.length,
		emit: harness.emit.bind(harness),
	};
}

/** An in-memory AtomicJsonFsAdapter -- no real disk I/O needed to prove manifestCache's read/write/fall-back behavior. */
function fakeFs(): AtomicJsonFsAdapter {
	const files = new Map<string, string>();
	return {
		writeFile(path, data) {
			files.set(path, data);
			return Promise.resolve();
		},
		rename(oldPath, newPath) {
			const data = files.get(oldPath);
			if (data === undefined) return Promise.reject(new Error(`ENOENT: ${oldPath}`));
			files.delete(oldPath);
			files.set(newPath, data);
			return Promise.resolve();
		},
		unlink(path) {
			files.delete(path);
			return Promise.resolve();
		},
		readFile(path) {
			const data = files.get(path);
			if (data === undefined) {
				const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				return Promise.reject(error);
			}
			return Promise.resolve(data);
		},
	};
}

async function execute(
	tool: ToolDefinition,
	input: unknown,
	signal?: AbortSignal,
	onUpdate?: (update: unknown) => void,
	contextOverrides: Record<string, unknown> = {},
) {
	return tool.execute(
		"pi-call-1",
		input as never,
		signal,
		onUpdate as never,
		{
			sessionManager: { getSessionId: () => "session-1" },
			hasUI: false,
			...contextOverrides,
		} as never,
	);
}

/**
 * Simulates a VehicleRegistry with configureApprovals() enabled: the first
 * invoke() of the gated operation always reports approval-required with a
 * fixed requestId; vehicle.approval.resolve mints "real-capability" only on
 * a granted decision; a retried invoke() only succeeds when that exact
 * capability is presented.
 */
class ApprovalFlowClient implements VehicleClient {
	readonly calls: Array<{ name: string; version: number; input: unknown; options: VehicleInvocationOptions | undefined }> = [];

	constructor(public value: VehicleManifest) {}

	manifest(): Promise<VehicleManifest> {
		return Promise.resolve(this.value);
	}

	async invoke<Output = unknown>(name: string, version: number, input: unknown, options?: VehicleInvocationOptions): Promise<Output> {
		this.calls.push({ name, version, input, options });
		if (name === "vehicle.approval.resolve") {
			const { requestId, decision } = input as { requestId: string; decision: "granted" | "denied" };
			return { requestId, decision, ...(decision === "granted" ? { capability: "real-capability" } : {}) } as Output;
		}
		if (options?.approvalCapability === "real-capability") return { ok: true } as Output;
		throw new VehicleError("approval-required", `${name}@${version} requires approval`, {
			category: "authorization",
			retryable: true,
			details: { requestId: "req-1", expiresAt: Date.now() + 60_000 },
		});
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

/** Same fake ExtensionContext shape the execute() helper builds inline, for calling invokeVehicleOperation() directly without a registered Pi tool at all. */
function fakeContext(overrides: Record<string, unknown> = {}) {
	return {
		sessionManager: { getSessionId: () => "session-1" },
		hasUI: false,
		...overrides,
	} as never;
}

describe("invokeVehicleOperation (standalone, no Pi tool registration)", () => {
	it("invokes the operation and returns the same content/details shape a registered tool's execute() would", async () => {
		const descriptor = operation("category.list");
		const client = new FakeClient(manifest([descriptor]));
		client.result = { categories: [] };

		const result = await invokeVehicleOperation({
			client,
			manifest: client.value,
			descriptor,
			toolName: "web_category",
			toolCallId: "call-1",
			input: { value: "x" },
			context: fakeContext(),
			options: {},
		});

		expect(client.calls[0]?.name).toBe("category.list");
		expect((result.details as PiVehicleToolDetails).output).toEqual({ categories: [] });
	});

	it("publishes activity events even though no Pi tool was ever registered", async () => {
		const events: VehicleActivityEvent[] = [];
		registerActivityBroker({ publish: (event) => events.push(event) });
		try {
			const descriptor = operation("category.assign");
			const client = new FakeClient(manifest([descriptor]));

			await invokeVehicleOperation({
				client,
				manifest: client.value,
				descriptor,
				toolName: "web_category",
				toolCallId: "call-1",
				input: { value: "x" },
				context: fakeContext(),
				options: {},
			});

			expect(events.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
		} finally {
			unregisterActivityBroker();
		}
	});

	it("a local /safety 'ask' override denies before ever calling invoke() -- same as a registered tool", async () => {
		const descriptor = operation("category.remove");
		const client = new FakeClient(manifest([descriptor]));
		const safetyPolicyStore = await VehicleSafetyPolicyStore.restore();
		await safetyPolicyStore.set("test-vehicle", "category.remove", "ask");

		await expect(
			invokeVehicleOperation({
				client,
				manifest: client.value,
				descriptor,
				toolName: "web_category",
				toolCallId: "call-1",
				input: { value: "x" },
				context: fakeContext({ hasUI: false }),
				options: { safetyPolicyStore },
			}),
		).rejects.toThrow(PiVehicleInvocationError);
		expect(client.calls).toHaveLength(0);
	});

	it("the server approval-required retry dance works identically to a registered tool's execute()", async () => {
		const descriptor = operation("category.remove", 1, { effect: "local-write" });
		const client = new ApprovalFlowClient(manifest([descriptor]));

		const result = await invokeVehicleOperation({
			client,
			manifest: client.value,
			descriptor,
			toolName: "web_category",
			toolCallId: "call-1",
			input: { value: "x" },
			context: fakeContext({
				hasUI: true,
				ui: { confirm: () => Promise.resolve(true) },
			}),
			options: {},
		});

		expect((result.details as PiVehicleToolDetails).output).toEqual({ ok: true });
		expect(client.calls.some((call) => call.name === "vehicle.approval.resolve")).toBe(true);
	});

	it("auto-injects an idempotencyKey from toolCallId for a keyed operation, exactly like execute() does", async () => {
		const descriptor = operation("category.assign", 1, { idempotency: { mode: "keyed", retentionMs: 60_000 } });
		const client = new FakeClient(manifest([descriptor]));

		await invokeVehicleOperation({
			client,
			manifest: client.value,
			descriptor,
			toolName: "web_category",
			toolCallId: "call-7",
			input: { value: "x" },
			context: fakeContext(),
			options: {},
		});

		expect(client.calls[0]?.options?.idempotencyKey).toBe("call-7");
		expect(client.calls[0]?.options?.correlationId).toBe("session-1");
	});
});

describe("registerVehicleTools", () => {
	it("projects descriptor schemas and invokes the exact Vehicle operation", async () => {
		const descriptor = operation("issues.search");
		const client = new FakeClient(manifest([descriptor]));
		const { pi, tools } = fakePi();

		const registered = await registerVehicleTools(pi, client);

		expect(registered.tools).toEqual([
			{
				toolName: "issues_search",
				operationName: "issues.search",
				operationVersion: 1,
				available: true,
				permissionsSatisfied: true,
				effect: "read",
				safetyState: "allow",
			},
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
			registerVehicleTools(collisionPi.pi, new FakeClient(manifest([operation("issues.search"), operation("issues_search")]))),
		).rejects.toThrow("collision");
		expect(collisionPi.tools).toHaveLength(0);

		const existing = fakePi(["issues_search"]);
		await expect(registerVehicleTools(existing.pi, new FakeClient(manifest([operation("issues.search")])))).rejects.toThrow(
			"already registered",
		);
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

	it("passes an explicitly resolved approvalCapability straight through without any gate of its own -- gating is the registry's job now", async () => {
		const client = new FakeClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, { resolveInvocation: () => ({ approvalCapability: "pre-approved" }) });
		await execute(tools[0]!, { value: "go" });
		expect(client.calls[0]?.options?.approvalCapability).toBe("pre-approved");
	});

	it("attempts a local UI approval prompt on approval-required, and retries with the capability vehicle.approval.resolve mints", async () => {
		const client = new ApprovalFlowClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client);

		const confirmCalls: Array<{ title: string; message: string }> = [];
		const result = await execute(tools[0]!, { value: "go" }, undefined, undefined, {
			hasUI: true,
			ui: {
				confirm: async (title: string, message: string) => {
					confirmCalls.push({ title, message });
					return true;
				},
			},
		});

		expect(confirmCalls).toHaveLength(1);
		expect(confirmCalls[0]?.message).toContain("destructive");
		expect(client.calls.map((call) => call.name)).toEqual(["risk.destructive", "vehicle.approval.resolve", "risk.destructive"]);
		expect(client.calls[1]?.input).toMatchObject({ requestId: "req-1", decision: "granted" });
		expect(client.calls[2]?.options?.approvalCapability).toBe("real-capability");
		expect(result.content).toBeTruthy();
	});

	it("denies and never retries invoke() when the local prompt returns false", async () => {
		const client = new ApprovalFlowClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client);

		await expect(
			execute(tools[0]!, { value: "go" }, undefined, undefined, { hasUI: true, ui: { confirm: async () => false } }),
		).rejects.toMatchObject({ failure: { code: "approval-required" } });
		expect(client.calls.map((call) => call.name)).toEqual(["risk.destructive", "vehicle.approval.resolve"]);
		expect(client.calls[1]?.input).toMatchObject({ decision: "denied" });
	});

	it("never attempts a local prompt when hasUI is false -- surfaces approval-required directly, no resolve call at all", async () => {
		const client = new ApprovalFlowClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client);

		await expect(execute(tools[0]!, { value: "go" })).rejects.toMatchObject({ failure: { code: "approval-required" } });
		expect(client.calls.map((call) => call.name)).toEqual(["risk.destructive"]);
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

	it("calls onInvoked with the resolved output after a successful invoke, and never lets its own error surface", async () => {
		const client = new FakeClient(manifest([operation("focus.test")]));
		client.result = { taskId: "task-1" };
		const { pi, tools } = fakePi();
		const seen: unknown[] = [];
		await registerVehicleTools(pi, client, {
			onInvoked: (request, output) => {
				seen.push({ operation: request.descriptor.name, output });
				throw new Error("broadcast failed");
			},
		});
		const result = await execute(tools[0]!, { value: "go" });
		expect(seen).toEqual([{ operation: "focus.test", output: { taskId: "task-1" } }]);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("task-1") });
	});

	it("never calls onInvoked when invoke() itself fails", async () => {
		const client = new FakeClient(manifest([operation("focus.test")]));
		client.error = new VehicleError("upstream-busy", "Provider is busy", { category: "unavailable", retryable: true });
		const { pi, tools } = fakePi();
		let called = false;
		await registerVehicleTools(pi, client, {
			onInvoked: () => {
				called = true;
			},
		});
		await expect(execute(tools[0]!, { value: "go" })).rejects.toThrow();
		expect(called).toBe(false);
	});

	it("lets a per-operation executionMode override win, defaulting to Pi's own concurrency mode when the resolver returns undefined", async () => {
		const client = new FakeClient(manifest([operation("discuss.open"), operation("issues.search")]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, {
			executionMode: (descriptor) => (descriptor.name === "discuss.open" ? "sequential" : undefined),
		});
		expect(tools.find((tool) => tool.name === "discuss_open")?.executionMode).toBe("sequential");
		expect(tools.find((tool) => tool.name === "issues_search")?.executionMode).toBeUndefined();
	});

	describe("interactiveFollowUps", () => {
		it("a follow-up returning a result overrides both content and details.output", async () => {
			const client = new FakeClient(manifest([operation("discuss.open")]));
			client.result = { discussion: { id: "d-1" }, rounds: [{ content: "question?" }] };
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client, {
				interactiveFollowUps: (descriptor) =>
					descriptor.name === "discuss.open"
						? async (_request, output) => ({
								content: [{ type: "text", text: `answered: ${(output as { rounds: { content: string }[] }).rounds[0]?.content}` }],
								output: { answered: true },
							})
						: undefined,
			});
			const result = await execute(tools[0]!, { value: "go" });
			expect(result.content[0]).toMatchObject({ text: "answered: question?" });
			expect((result.details as PiVehicleToolDetails).output).toEqual({ answered: true });
			expect((result.details as PiVehicleToolDetails).vehicle.operation).toBe("discuss.open");
		});

		it("a follow-up returning undefined falls back to the default content/details, unchanged", async () => {
			const client = new FakeClient(manifest([operation("discuss.list")]));
			client.result = { discussions: [] };
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client, { interactiveFollowUps: () => async () => undefined });
			const result = await execute(tools[0]!, { value: "go" });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("discussions") });
			expect((result.details as PiVehicleToolDetails).output).toEqual({ discussions: [] });
		});

		it("the resolver only applies its follow-up to the operation it targets -- every other operation is unaffected", async () => {
			const client = new FakeClient(manifest([operation("issues.search")]));
			client.result = { hits: 3 };
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client, {
				interactiveFollowUps: (descriptor) => (descriptor.name === "discuss.open" ? async () => ({ content: [] }) : undefined),
			});
			const result = await execute(tools[0]!, { value: "go" });
			expect((result.details as PiVehicleToolDetails).output).toEqual({ hits: 3 });
		});

		it("omitting interactiveFollowUps entirely behaves exactly as before this option existed", async () => {
			const client = new FakeClient(manifest([operation("focus.test")]));
			client.result = { taskId: "task-1" };
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client, {});
			const result = await execute(tools[0]!, { value: "go" });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("task-1") });
		});

		it("a follow-up's own thrown error propagates as a real tool failure, even though the primary invoke() already succeeded", async () => {
			const client = new FakeClient(manifest([operation("discuss.open")]));
			client.result = { discussion: { id: "d-1" } };
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client, {
				interactiveFollowUps: () => async () => {
					throw new Error("the follow-up's own round trip failed");
				},
			});
			await expect(execute(tools[0]!, { value: "go" })).rejects.toThrow("the follow-up's own round trip failed");
			// The primary invoke() itself is not retried or rolled back -- exactly one call was made.
			expect(client.calls).toHaveLength(1);
		});

		it("the follow-up receives the tool call's own signal and onUpdate, for its own abortable/progress-reporting round trip", async () => {
			const client = new FakeClient(manifest([operation("discuss.open")]));
			client.result = { discussion: { id: "d-1" } };
			const { pi, tools } = fakePi();
			const controller = new AbortController();
			const updates: unknown[] = [];
			let seenSignal: AbortSignal | undefined;
			await registerVehicleTools(pi, client, {
				interactiveFollowUps: () => async (request) => {
					seenSignal = request.signal;
					request.onUpdate?.({
						content: [{ type: "text", text: "waiting" }],
						details: { vehicle: { name: "t", version: "1", operation: "discuss.open", operationVersion: 1, toolCallId: "pi-call-1" } },
					});
					return { content: [{ type: "text", text: "done" }] };
				},
			});
			await execute(tools[0]!, { value: "go" }, controller.signal, (update) => updates.push(update));
			expect(seenSignal).toBe(controller.signal);
			// FakeClient's own invoke() also reports one progress update of its own (the primary
			// call's usual onProgress plumbing, unrelated to the follow-up) -- the follow-up's own
			// update is the last one, not necessarily the only one.
			expect((updates.at(-1) as { content: unknown }).content).toEqual([{ type: "text", text: "waiting" }]);
		});

		it("the follow-up receives the real VehicleClient, usable to make its own additional invoke() calls", async () => {
			const client = new FakeClient(manifest([operation("discuss.open")]));
			client.result = { discussion: { id: "d-1" } };
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client, {
				interactiveFollowUps: () => async (_request, _output, followUpClient) => {
					const replied = await followUpClient.invoke("discuss.reply", 1, { id: "d-1", content: "answer" });
					return { content: [{ type: "text", text: "done" }], output: replied };
				},
			});
			const result = await execute(tools[0]!, { value: "go" });
			expect(result.content[0]).toMatchObject({ text: "done" });
			expect(client.calls.map((call) => call.name)).toEqual(["discuss.open", "discuss.reply"]);
		});
	});

	describe("activity broker wiring", () => {
		afterEach(() => {
			unregisterActivityBroker();
		});

		it("publishes started then completed on a successful invoke, with no option needed to opt in", async () => {
			const received: VehicleActivityEvent[] = [];
			registerActivityBroker({ publish: (evt) => received.push(evt) });
			const client = new FakeClient(manifest([operation("issues.sync")]));
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client);

			await execute(tools[0]!, { value: "go" });

			expect(received.map((evt) => evt.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
			expect(received[0]?.refs?.operation).toBe("issues.sync");
			expect(received[1]?.severity).toBe("success");
		});

		it("publishes started then failed when invoke() rejects", async () => {
			const received: VehicleActivityEvent[] = [];
			registerActivityBroker({ publish: (evt) => received.push(evt) });
			const client = new FakeClient(manifest([operation("issues.sync")]));
			client.error = new VehicleError("upstream-busy", "Provider is busy", { category: "unavailable", retryable: true });
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client);

			await expect(execute(tools[0]!, { value: "go" })).rejects.toThrow();

			expect(received.map((evt) => evt.type)).toEqual(["vehicle.operation.started", "vehicle.operation.failed"]);
			expect(received[1]?.severity).toBe("error");
			expect(received[1]?.details).toMatchObject({ code: "upstream-busy" });
		});

		it("is a true no-op when no broker is registered -- invoke() behavior is unaffected", async () => {
			const client = new FakeClient(manifest([operation("issues.sync")]));
			client.result = { ok: true };
			const { pi, tools } = fakePi();
			await registerVehicleTools(pi, client);

			const result = await execute(tools[0]!, { value: "go" });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("true") });
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
		const { pi, tools, emit } = fakePi();
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

		await emit("session_shutdown");
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
			{
				toolName: "issues_search",
				operationName: "issues.search",
				operationVersion: 1,
				available: true,
				permissionsSatisfied: true,
				effect: "read",
				safetyState: "allow",
			},
			{
				toolName: "jira_search",
				operationName: "jira.search",
				operationVersion: 1,
				available: false,
				permissionsSatisfied: true,
				effect: "read",
				safetyState: "allow",
			},
		]);
	});

	it("never disables an unrelated already-active tool while curating its own", async () => {
		const client = new FakeClient(manifest([operation("issues.search", 1, { available: false })]));
		const { pi, activeTools } = fakePi(["read", "edit"]);

		await registerVehicleTools(pi, client);

		expect(activeTools().sort()).toEqual(["edit", "read"]);
	});

	it("registers a permission-ineligible operation's tool but never activates it -- registered in getAllTools(), absent from getActiveTools()", async () => {
		const client = new FakeClient(
			manifest([
				operation("issues.search", 1, { permissions: ["issues:read"] }),
				operation("issues.write", 1, { permissions: ["issues:write"] }),
			]),
		);
		const { pi, tools, activeTools } = fakePi();

		const registered = await registerVehicleTools(pi, client, { permissions: ["issues:read"] });

		expect(tools.map((tool) => tool.name).sort()).toEqual(["issues_search", "issues_write"]);
		expect(activeTools().sort()).toEqual(["issues_search"]);
		expect(registered.tools).toEqual([
			{
				toolName: "issues_search",
				operationName: "issues.search",
				operationVersion: 1,
				available: true,
				permissionsSatisfied: true,
				effect: "read",
				safetyState: "allow",
			},
			{
				toolName: "issues_write",
				operationName: "issues.write",
				operationVersion: 1,
				available: true,
				permissionsSatisfied: false,
				effect: "read",
				safetyState: "blocked",
			},
		]);
	});

	it("requires every declared permission, not just one of several", async () => {
		const client = new FakeClient(manifest([operation("issues.write", 1, { permissions: ["issues:read", "issues:write"] })]));
		const { pi, activeTools } = fakePi();

		await registerVehicleTools(pi, client, { permissions: ["issues:read"] });

		expect(activeTools()).toEqual([]);
	});

	it("never hides a tool over an operation with no declared permissions, matching the registry's own missing.length === 0 rule", async () => {
		const client = new FakeClient(manifest([operation("issues.search", 1, { permissions: [] })]));
		const { pi, activeTools } = fakePi();

		await registerVehicleTools(pi, client, { permissions: [] });

		expect(activeTools()).toEqual(["issues_search"]);
	});

	it("registers renderers during async extension loading and defers runtime-dependent activation until session_start", async () => {
		const client = new FakeClient(manifest([operation("issues.search", 1, { available: false })]));
		const tools: ToolDefinition[] = [];
		const sessionStartHandlers: Array<() => void> = [];
		let loading = true;
		let activeTools: string[] = [];
		const actionMethod = <T>(value: T): T => {
			if (loading) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
			return value;
		};
		const pi = {
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
				activeTools.push(tool.name);
			},
			getAllTools: () => actionMethod(tools),
			getActiveTools: () => actionMethod([...activeTools]),
			setActiveTools(names: string[]) {
				actionMethod(undefined);
				activeTools = [...names];
			},
			on(name: string, handler: () => void) {
				if (name === "session_start") sessionStartHandlers.push(handler);
			},
		} as unknown as ExtensionAPI;

		await registerVehicleTools(pi, client);

		expect(tools).toHaveLength(1);
		expect(tools[0]?.renderResult).toBeDefined();
		expect(activeTools).toEqual(["issues_search"]);
		expect(sessionStartHandlers).toHaveLength(1);

		loading = false;
		for (const handler of sessionStartHandlers) handler();
		expect(activeTools).toEqual([]);
	});

	it('sets promptSnippet so Pi\'s "Available tools" system-prompt section lists the tool -- omitted entirely otherwise, confirmed live', async () => {
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
			{
				toolName: "jira_search",
				operationName: "jira.search",
				operationVersion: 1,
				available: true,
				permissionsSatisfied: true,
				effect: "read",
				safetyState: "allow",
			},
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

	it("reveals a tool once options.permissions gains the coverage it was missing, without re-registering it", async () => {
		const client = new FakeClient(manifest([operation("issues.write", 1, { permissions: ["issues:write"] })]));
		const { pi, tools, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, client, { permissions: [] });
		expect(activeTools()).toEqual([]);

		const refreshed = await refreshVehicleToolAvailability(pi, client, registered, { permissions: ["issues:write"] });

		expect(tools).toHaveLength(1); // still exactly one registerTool call ever
		expect(activeTools()).toEqual(["issues_write"]);
		expect(refreshed.tools[0]?.permissionsSatisfied).toBe(true);
	});

	it("hides a tool once options.permissions loses coverage it previously had, e.g. a delegated-scope downgrade", async () => {
		const client = new FakeClient(manifest([operation("issues.write", 1, { permissions: ["issues:write"] })]));
		const { pi, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, client, { permissions: ["issues:write"] });
		expect(activeTools()).toEqual(["issues_write"]);

		const refreshed = await refreshVehicleToolAvailability(pi, client, registered, { permissions: [] });

		expect(activeTools()).toEqual([]);
		expect(refreshed.tools[0]?.permissionsSatisfied).toBe(false);
	});
});

describe("registerVehicleTools / refreshVehicleToolAvailability: manifestCache survives a restart/reload while the daemon is unreachable", () => {
	it("without manifestCache configured, a factory-time manifest() failure still throws -- zero behavior change for every existing caller", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.manifestError = new Error("daemon unreachable");
		const { pi } = fakePi();
		await expect(registerVehicleTools(pi, client)).rejects.toThrow("daemon unreachable");
	});

	it("a successful registration persists the manifest to the cache file", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		const { pi } = fakePi();
		const fs = fakeFs();
		const registered = await registerVehicleTools(pi, client, { manifestCache: { filePath: "/cache/vehicle.json", fs } });
		expect(registered.stale).toBe(false);
		expect(await fs.readFile("/cache/vehicle.json")).toContain("issues.search");
	});

	/** The exact production scenario: a prior successful session persisted the cache, then the process restarted/reloaded while the daemon happened to be down (a crash-loop, a slow restart) -- transcript replay of a historical tool call still needs a real renderer, not a thrown registration error. */
	it("falls back to a previously-cached manifest when the live fetch fails, registering tools and their renderers anyway", async () => {
		const fs = fakeFs();
		const warmClient = new FakeClient(manifest([operation("issues.search")]));
		await registerVehicleTools(fakePi().pi, warmClient, { manifestCache: { filePath: "/cache/vehicle.json", fs } });

		const coldClient = new FakeClient(manifest([operation("issues.search")]));
		coldClient.manifestError = new Error("daemon unreachable");
		const { pi, tools } = fakePi();
		const registered = await registerVehicleTools(pi, coldClient, { manifestCache: { filePath: "/cache/vehicle.json", fs } });

		expect(registered.stale).toBe(true);
		expect(registered.tools.map((tool) => tool.operationName)).toEqual(["issues.search"]);
		expect(tools).toHaveLength(1); // the renderer-carrying Pi tool really got registered, not skipped
	});

	it("still rethrows the original failure when manifestCache is configured but nothing has ever been cached yet", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.manifestError = new Error("daemon unreachable");
		const { pi } = fakePi();
		await expect(
			registerVehicleTools(pi, client, { manifestCache: { filePath: "/cache/never-written.json", fs: fakeFs() } }),
		).rejects.toThrow("daemon unreachable");
	});

	it("a fallback-registered tool still activates once refreshVehicleToolAvailability succeeds against a live daemon, matching the session_start reconciliation every consumer already wires up", async () => {
		const fs = fakeFs();
		const warmClient = new FakeClient(manifest([operation("issues.search")]));
		await registerVehicleTools(fakePi().pi, warmClient, { manifestCache: { filePath: "/cache/vehicle.json", fs } });

		const coldClient = new FakeClient(manifest([operation("issues.search")]));
		coldClient.manifestError = new Error("daemon unreachable");
		const { pi, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, coldClient, { manifestCache: { filePath: "/cache/vehicle.json", fs } });
		expect(activeTools()).toEqual(["issues_search"]); // registered active immediately: the cached descriptor was already available:true

		// The daemon comes back -- a live refresh (e.g. pi-status-refresh's own session_start hook) now succeeds.
		coldClient.manifestError = undefined;
		const refreshed = await refreshVehicleToolAvailability(pi, coldClient, registered, {
			manifestCache: { filePath: "/cache/vehicle.json", fs },
		});
		expect(refreshed.stale).toBe(false);
		expect(activeTools()).toEqual(["issues_search"]);
	});

	it("a failed refresh keeps throwing even with manifestCache configured -- refresh's whole point is verifying a real live daemon, never silently reusing stale data as if it were fresh", async () => {
		const fs = fakeFs();
		const client = new FakeClient(manifest([operation("issues.search")]));
		const { pi } = fakePi();
		const registered = await registerVehicleTools(pi, client, { manifestCache: { filePath: "/cache/vehicle.json", fs } });

		client.manifestError = new Error("daemon unreachable");
		await expect(
			refreshVehicleToolAvailability(pi, client, registered, { manifestCache: { filePath: "/cache/vehicle.json", fs } }),
		).rejects.toThrow("daemon unreachable");
	});
});

describe("safety policy (VehicleSafetyPolicyStore + classification)", () => {
	afterEach(() => {
		__resetVehicleSafetyRegistryForTests();
	});

	it("a blocked override hides an otherwise-permitted tool", async () => {
		const client = new FakeClient(manifest([operation("issues.write")]));
		const { pi, activeTools } = fakePi();
		const safetyPolicyStore = await VehicleSafetyPolicyStore.restore();
		await safetyPolicyStore.set("test-vehicle", "issues.write", "blocked");

		const registered = await registerVehicleTools(pi, client, { safetyPolicyStore });

		expect(activeTools()).toEqual([]);
		expect(registered.tools[0]?.safetyState).toBe("blocked");
	});

	it("an allow override reveals a tool the effect-level default would otherwise gate", async () => {
		const client = new FakeClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, activeTools } = fakePi();
		const safetyPolicyStore = await VehicleSafetyPolicyStore.restore();
		await safetyPolicyStore.set("test-vehicle", "risk.destructive", "allow");

		const registered = await registerVehicleTools(pi, client, { safetyPolicyStore });

		expect(activeTools()).toEqual(["risk_destructive"]);
		expect(registered.tools[0]?.safetyState).toBe("allow");
	});

	it("refreshVehicleToolAvailability re-evaluates the safety policy store, not just permissions/availability", async () => {
		const client = new FakeClient(manifest([operation("issues.write")]));
		const { pi, activeTools } = fakePi();
		const safetyPolicyStore = await VehicleSafetyPolicyStore.restore();
		const registered = await registerVehicleTools(pi, client, { safetyPolicyStore });
		expect(activeTools()).toEqual(["issues_write"]);

		await safetyPolicyStore.set("test-vehicle", "issues.write", "blocked");
		const refreshed = await refreshVehicleToolAvailability(pi, client, registered, { safetyPolicyStore });

		expect(activeTools()).toEqual([]);
		expect(refreshed.tools[0]?.safetyState).toBe("blocked");
	});

	it("an override of 'ask' gates execute() with a local confirm before ever calling invoke() -- denial never touches the client at all", async () => {
		const client = new FakeClient(manifest([operation("issues.write")]));
		const { pi, tools } = fakePi();
		const safetyPolicyStore = await VehicleSafetyPolicyStore.restore();
		await safetyPolicyStore.set("test-vehicle", "issues.write", "ask");
		await registerVehicleTools(pi, client, { safetyPolicyStore });

		await expect(
			execute(tools[0]!, { value: "go" }, undefined, undefined, { hasUI: true, ui: { confirm: async () => false } }),
		).rejects.toThrow(PiVehicleInvocationError);
		expect(client.calls).toHaveLength(0);
	});

	it("an override of 'ask', once approved locally, proceeds to invoke() normally", async () => {
		const client = new FakeClient(manifest([operation("issues.write")]));
		const { pi, tools } = fakePi();
		const safetyPolicyStore = await VehicleSafetyPolicyStore.restore();
		await safetyPolicyStore.set("test-vehicle", "issues.write", "ask");
		await registerVehicleTools(pi, client, { safetyPolicyStore });

		const result = await execute(tools[0]!, { value: "go" }, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });

		expect(client.calls.map((call) => call.name)).toEqual(["issues.write"]);
		expect(result.content).toBeTruthy();
	});

	it("registerVehicleTools contributes to the shared safety registry unconditionally -- no option needed to opt in", async () => {
		const client = new FakeClient(manifest([operation("issues.search"), operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi } = fakePi();

		await registerVehicleTools(pi, client);

		const contributors = listVehicleSafetyContributors();
		expect(contributors.map((c) => c.source)).toEqual(["test-vehicle"]);
		const contribution = await contributors[0]!.resolve();
		expect(contribution.vehicleName).toBe("test-vehicle");
		expect(contribution.tools).toEqual([
			{ toolName: "issues_search", operationName: "issues.search", effect: "read", state: "allow" },
			{ toolName: "risk_destructive", operationName: "risk.destructive", effect: "destructive", state: "ask" },
		]);
	});

	it("a refresh replaces the prior contribution instead of duplicating it", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		const { pi } = fakePi();
		const registered = await registerVehicleTools(pi, client);

		client.value = manifest([operation("issues.search"), operation("issues.create")]);
		await refreshVehicleToolAvailability(pi, client, registered);

		expect(listVehicleSafetyContributors()).toHaveLength(1);
		const contribution = await listVehicleSafetyContributors()[0]!.resolve();
		expect(contribution.tools.map((t) => t.operationName).sort()).toEqual(["issues.create", "issues.search"]);
	});
});
