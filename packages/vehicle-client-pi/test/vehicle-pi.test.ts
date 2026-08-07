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
	// Matches execute()'s own output shape, for a caller with no registered Pi tool at all.
	it("invokes the operation and returns execute()'s own content/details shape", async () => {
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

	// Same denial behavior as a registered tool's execute().
	it("a local /safety 'ask' override denies before ever calling invoke()", async () => {
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

	// Must behave identically to a registered tool's execute().
	it("runs the server approval-required retry dance", async () => {
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

	// Matches execute()'s own idempotency-key injection exactly.
	it("auto-injects an idempotencyKey from toolCallId for a keyed operation", async () => {
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

	// Version suffixing and collision rejection must both be atomic -- a collision leaves zero tools registered.
	it("suffixes multiple operation versions and rejects name collisions atomically", async () => {
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

	// Gating moved to the registry; this call site no longer duplicates that check.
	it("passes an explicitly resolved approvalCapability straight through, no gate of its own", async () => {
		const client = new FakeClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, { resolveInvocation: () => ({ approvalCapability: "pre-approved" }) });
		await execute(tools[0]!, { value: "go" });
		expect(client.calls[0]?.options?.approvalCapability).toBe("pre-approved");
	});

	it("prompts locally on approval-required, then retries with the minted capability", async () => {
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

	// No UI means no prompt is possible; surface approval-required directly instead.
	it("never attempts a local prompt when hasUI is false", async () => {
		const client = new ApprovalFlowClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client);

		await expect(execute(tools[0]!, { value: "go" })).rejects.toMatchObject({ failure: { code: "approval-required" } });
		expect(client.calls.map((call) => call.name)).toEqual(["risk.destructive"]);
	});

	// vehicle.approval.resolve is invoked only by this package's own retry dance, never by the model.
	it("never projects vehicle.approval.resolve as a callable Pi tool, even fully permissioned", async () => {
		const client = new FakeClient(
			manifest([
				operation("risk.destructive", 1, { effect: "destructive" }),
				operation("vehicle.approval.resolve", 1, { permissions: ["vehicle:approvals:resolve"] }),
			]),
		);
		const { pi, tools } = fakePi();

		const registered = await registerVehicleTools(pi, client, { permissions: ["vehicle:approvals:resolve"] });

		expect(tools.map((tool) => tool.name)).toEqual(["risk_destructive"]);
		expect(registered.tools.map((tool) => tool.operationName)).toEqual(["risk.destructive"]);
	});

	it("refreshVehicleToolAvailability also never projects vehicle.approval.resolve", async () => {
		const client = new FakeClient(manifest([operation("risk.destructive", 1, { effect: "destructive" })]));
		const { pi, tools } = fakePi();
		const registered = await registerVehicleTools(pi, client, { permissions: ["vehicle:approvals:resolve"] });

		client.value = manifest([
			operation("risk.destructive", 1, { effect: "destructive" }),
			operation("vehicle.approval.resolve", 1, { permissions: ["vehicle:approvals:resolve"] }),
		]);
		const refreshed = await refreshVehicleToolAvailability(pi, client, registered, { permissions: ["vehicle:approvals:resolve"] });

		expect(tools.map((tool) => tool.name)).toEqual(["risk_destructive"]);
		expect(refreshed.tools.map((tool) => tool.operationName)).toEqual(["risk.destructive"]);
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

	// onInvoked's own thrown error must never surface as an invoke() failure.
	it("calls onInvoked with the resolved output after a successful invoke", async () => {
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

	it("surfaces a transport error's own .cause detail, not just its top-level message", async () => {
		// Regression guard for a real live incident: pi-pipes' ci.wait surfaced only "vehicle-client-failed:
		// fetch failed" with zero further detail -- Node's fetch() always populates a TypeError's .cause with
		// the real underlying reason (ECONNREFUSED, ECONNRESET, DNS failure, ...), but sanitizedFailure()'s
		// generic fallback branch dropped it on the floor, leaving nothing to diagnose from.
		const client = new FakeClient(manifest([operation("focus.test")]));
		client.error = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:41203") });
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, {});
		try {
			await execute(tools[0]!, { value: "go" });
			throw new Error("expected invocation failure");
		} catch (error) {
			expect(error).toBeInstanceOf(PiVehicleInvocationError);
			const failure = (error as PiVehicleInvocationError).failure;
			expect(failure.code).toBe("vehicle-client-failed");
			expect(failure.message).toBe("fetch failed");
			expect(failure.causeMessage).toBe("connect ECONNREFUSED 127.0.0.1:41203");
			// .message (not just .failure) is what Pi's surface actually shows -- labeled with the
			// failing Vehicle's own name (this fixture's manifest is named "test-vehicle"), not the
			// generic "vehicle-client-failed" code, which carries zero information a user doesn't
			// already have (every failure here is "a vehicle client failed").
			expect((error as Error).message).toBe("test-vehicle: fetch failed (connect ECONNREFUSED 127.0.0.1:41203)");
		}
	});

	it("still shows a real domain error code as-is, unlike the generic transport-failure fallback", async () => {
		const client = new FakeClient(manifest([operation("fail.test")]));
		client.error = new VehicleError("not-found", "task xyz not found", { category: "not_found" });
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, {});
		try {
			await execute(tools[0]!, { value: "go" });
			throw new Error("expected invocation failure");
		} catch (error) {
			expect(error).toBeInstanceOf(PiVehicleInvocationError);
			// A real domain code is informative on its own -- the Vehicle-name substitution
			// only ever applies to the one generic transport-failure fallback code.
			expect((error as Error).message).toBe("not-found: task xyz not found");
		}
	});

	it("appends a capacity failure's own actualBytes/maxBytes details", async () => {
		// Regression guard: enforcePayloadSize (vehicle-server) attaches details: { actualBytes,
		// maxBytes } on a response-too-large failure, but it was silently dropped before reaching a
		// human/agent -- a tasks.list@1 oversized-response failure showed only the bare message, no
		// way to know how far over the cap the real payload was or what limit would fit.
		const client = new FakeClient(manifest([operation("fail.test")]));
		client.error = new VehicleError("response-too-large", "tasks.list@1 response exceeds its 262144-byte limit", {
			category: "capacity",
			details: { actualBytes: 300_000, maxBytes: 262_144 },
		});
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, {});
		try {
			await execute(tools[0]!, { value: "go" });
			throw new Error("expected invocation failure");
		} catch (error) {
			expect(error).toBeInstanceOf(PiVehicleInvocationError);
			expect((error as PiVehicleInvocationError).failure.details).toEqual({ actualBytes: 300_000, maxBytes: 262_144 });
			expect((error as Error).message).toBe(
				"response-too-large: tasks.list@1 response exceeds its 262144-byte limit (actualBytes=300000, maxBytes=262144)",
			);
		}
	});

	it("combines causeMessage and details when a failure carries both, causeMessage first", async () => {
		const client = new FakeClient(manifest([operation("fail.test")]));
		client.error = new VehicleError("response-too-large", "response too large", {
			category: "capacity",
			details: { actualBytes: 999 },
			cause: new Error("underlying cause"),
			exposeCause: true,
		});
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, {});
		try {
			await execute(tools[0]!, { value: "go" });
			throw new Error("expected invocation failure");
		} catch (error) {
			expect((error as Error).message).toBe("response-too-large: response too large (underlying cause; actualBytes=999)");
		}
	});

	// Never inlines an arbitrary nested JsonValue.
	it("omits the details annotation for a non-object, empty, or all-nested-value details", async () => {
		const client = new FakeClient(manifest([operation("fail.test")]));
		client.error = new VehicleError("internal", "boom", { category: "internal", details: { nested: { a: 1 } } });
		const { pi, tools } = fakePi();
		await registerVehicleTools(pi, client, {});
		try {
			await execute(tools[0]!, { value: "go" });
			throw new Error("expected invocation failure");
		} catch (error) {
			expect((error as Error).message).toBe("internal: boom");
		}
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

	// Falls back to Pi's own concurrency mode when the resolver returns undefined.
	it("lets a per-operation executionMode override win over Pi's own default", async () => {
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

		// Every other operation is unaffected by a resolver targeting one specific operation.
		it("the resolver only applies its follow-up to the operation it targets", async () => {
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

		// The primary invoke() already succeeded; the follow-up's own failure must still surface.
		it("a follow-up's own thrown error propagates as a real tool failure", async () => {
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

		// Lets the follow-up's own round trip be abortable and report progress like the primary call.
		it("the follow-up receives the tool call's own signal and onUpdate", async () => {
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

		it("the follow-up receives the real VehicleClient, for its own additional invoke() calls", async () => {
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

	// An inactive tool is invisible to the LLM even though it's registered.
	it("registers a currently-unavailable operation's tool but never activates it", async () => {
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

	// Present in getAllTools(), absent from getActiveTools().
	it("registers a permission-ineligible operation's tool but never activates it", async () => {
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

	// Matches the registry's own missing.length === 0 rule.
	it("never hides a tool for an operation with no declared permissions", async () => {
		const client = new FakeClient(manifest([operation("issues.search", 1, { permissions: [] })]));
		const { pi, activeTools } = fakePi();

		await registerVehicleTools(pi, client, { permissions: [] });

		expect(activeTools()).toEqual(["issues_search"]);
	});

	it("registers renderers during loading, defers activation until session_start", async () => {
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

	// Omitted entirely otherwise -- confirmed live.
	it('sets promptSnippet so the "Available tools" system-prompt section lists the tool', async () => {
		const descriptor = operation("issues.search");
		const client = new FakeClient(manifest([descriptor]));
		const { pi, tools } = fakePi();

		await registerVehicleTools(pi, client);

		expect(tools[0]?.promptSnippet).toBe(descriptor.description);
	});

	// A projected tool never falls back to Pi's raw-JSON rendering.
	it("wires the generic Vehicle renderer by default", async () => {
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

	// Only when the output actually carries content blocks.
	it("sends an operation's own content blocks to the model instead of raw JSON", async () => {
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

	// Never forwards partial content blocks.
	it("falls back to raw JSON when an output's content field is malformed", async () => {
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

	// Doesn't re-register the tool -- only its active/inactive state changes.
	it("reveals a tool once options.permissions gains the coverage it was missing", async () => {
		const client = new FakeClient(manifest([operation("issues.write", 1, { permissions: ["issues:write"] })]));
		const { pi, tools, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, client, { permissions: [] });
		expect(activeTools()).toEqual([]);

		const refreshed = await refreshVehicleToolAvailability(pi, client, registered, { permissions: ["issues:write"] });

		expect(tools).toHaveLength(1); // still exactly one registerTool call ever
		expect(activeTools()).toEqual(["issues_write"]);
		expect(refreshed.tools[0]?.permissionsSatisfied).toBe(true);
	});

	// E.g. a delegated-scope downgrade.
	it("hides a tool once options.permissions loses coverage it previously had", async () => {
		const client = new FakeClient(manifest([operation("issues.write", 1, { permissions: ["issues:write"] })]));
		const { pi, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, client, { permissions: ["issues:write"] });
		expect(activeTools()).toEqual(["issues_write"]);

		const refreshed = await refreshVehicleToolAvailability(pi, client, registered, { permissions: [] });

		expect(activeTools()).toEqual([]);
		expect(refreshed.tools[0]?.permissionsSatisfied).toBe(false);
	});
});

// Survives a restart/reload while the daemon is unreachable.
describe("registerVehicleTools / refreshVehicleToolAvailability: manifestCache", () => {
	/** A permanent failure still throws, same as before the handshake retry existed -- it just no longer throws on the very first attempt: see RegisterVehicleToolsOptions.handshake. */
	it("without manifestCache configured, a factory-time manifest() failure still throws", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.manifestError = new Error("daemon unreachable");
		const { pi } = fakePi();
		await expect(registerVehicleTools(pi, client, { handshake: { attempts: 1 } })).rejects.toThrow("daemon unreachable");
	});

	// Never touches manifestCache when the retry alone succeeds.
	it("retries the initial manifest fetch and succeeds once a transient failure clears", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.manifestError = new Error("daemon unreachable");
		const { pi } = fakePi();
		let manifestCallCount = 0;
		const originalManifest = client.manifest.bind(client);
		client.manifest = () => {
			manifestCallCount++;
			if (manifestCallCount >= 3) client.manifestError = undefined;
			return originalManifest();
		};

		const registered = await registerVehicleTools(pi, client, { handshake: { attempts: 5, initialDelayMs: 1, maxDelayMs: 5 } });

		expect(manifestCallCount).toBe(3);
		expect(registered.tools.map((tool) => tool.operationName)).toEqual(["issues.search"]);
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
	it("falls back to a previously-cached manifest when the live fetch fails", async () => {
		const fs = fakeFs();
		const warmClient = new FakeClient(manifest([operation("issues.search")]));
		await registerVehicleTools(fakePi().pi, warmClient, { manifestCache: { filePath: "/cache/vehicle.json", fs } });

		const coldClient = new FakeClient(manifest([operation("issues.search")]));
		coldClient.manifestError = new Error("daemon unreachable");
		const { pi, tools } = fakePi();
		const registered = await registerVehicleTools(pi, coldClient, {
			manifestCache: { filePath: "/cache/vehicle.json", fs },
			handshake: { attempts: 1 },
		});

		expect(registered.stale).toBe(true);
		expect(registered.tools.map((tool) => tool.operationName)).toEqual(["issues.search"]);
		expect(tools).toHaveLength(1); // the renderer-carrying Pi tool really got registered, not skipped
	});

	// Even though manifestCache is configured.
	it("still rethrows the original failure when nothing has ever been cached yet", async () => {
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.manifestError = new Error("daemon unreachable");
		const { pi } = fakePi();
		await expect(
			registerVehicleTools(pi, client, {
				manifestCache: { filePath: "/cache/never-written.json", fs: fakeFs() },
				handshake: { attempts: 1 },
			}),
		).rejects.toThrow("daemon unreachable");
	});

	// Matches the session_start reconciliation every consumer already wires up.
	it("a fallback-registered tool still activates once a live refresh succeeds", async () => {
		const fs = fakeFs();
		const warmClient = new FakeClient(manifest([operation("issues.search")]));
		await registerVehicleTools(fakePi().pi, warmClient, { manifestCache: { filePath: "/cache/vehicle.json", fs } });

		const coldClient = new FakeClient(manifest([operation("issues.search")]));
		coldClient.manifestError = new Error("daemon unreachable");
		const { pi, activeTools } = fakePi();
		const registered = await registerVehicleTools(pi, coldClient, {
			manifestCache: { filePath: "/cache/vehicle.json", fs },
			handshake: { attempts: 1 },
		});
		expect(activeTools()).toEqual(["issues_search"]); // registered active immediately: the cached descriptor was already available:true

		// The daemon comes back -- a live refresh (e.g. pi-status-refresh's own session_start hook) now succeeds.
		coldClient.manifestError = undefined;
		const refreshed = await refreshVehicleToolAvailability(pi, coldClient, registered, {
			manifestCache: { filePath: "/cache/vehicle.json", fs },
		});
		expect(refreshed.stale).toBe(false);
		expect(activeTools()).toEqual(["issues_search"]);
	});

	// refresh's whole point is verifying a live daemon -- never silently reuse stale cached data as fresh.
	it("a failed refresh keeps throwing even with manifestCache configured", async () => {
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

/**
 * A live-reported bug (after /reload, a previously well-rendered Vehicle tool call renders as
 * raw JSON instead of through its renderCall/renderResult) motivated this suite, modeled on
 * pi-papyrus's real registerNotesVehicle: registerVehicleTools() called from session_start,
 * wrapped in a try/catch that silently swallows any failure. The original hypothesis -- a stale
 * tool name surviving in Pi's registry long enough to collide with the fresh post-reload
 * registration -- is REFUTED by @earendil-works/pi-coding-agent's own source: AgentSession.reload()
 * constructs a brand-new ExtensionRunner with an empty tools Map per extension before
 * session_start ever re-fires, and every registerTool() call immediately refreshes the registry.
 * There is no stale-registry window, so that collision can't happen; the real mechanism behind
 * the reported symptom is still open. What remains here just verifies reload() itself re-runs
 * registration correctly, which the harness's own reload() tests already establish generically --
 * this is the Vehicle-specific instance of that same guarantee.
 */
describe("registerVehicleTools across a simulated /reload", () => {
	function papyrusStyleFactory(client: VehicleClient) {
		return (pi: ExtensionAPI) => {
			pi.on("session_start", async () => {
				try {
					await registerVehicleTools(pi, client);
				} catch {
					// Daemon state is stale/unreachable -- degrade silently, matching
					// pi-papyrus's own registerNotesVehicle comment verbatim.
				}
			});
		};
	}

	it("registers renderCall and renderResult on first registration", async () => {
		const client = new FakeClient(manifest([operation("tasks.show")]));
		const h = createExtensionHarness(papyrusStyleFactory(client));
		await h.boot();

		const tool = h.tools.get("tasks_show");
		expect(tool).toBeDefined();
		expect(typeof tool?.definition.renderCall).toBe("function");
		expect(typeof tool?.definition.renderResult).toBe("function");
	});

	it("re-registers renderCall and renderResult fresh after reload", async () => {
		const client = new FakeClient(manifest([operation("tasks.show")]));
		const h = createExtensionHarness(papyrusStyleFactory(client));
		await h.boot();
		const before = h.tools.get("tasks_show");
		expect(before).toBeDefined();

		await h.reload();

		const after = h.tools.get("tasks_show");
		expect(after).toBeDefined();
		expect(typeof after?.definition.renderCall).toBe("function");
		expect(typeof after?.definition.renderResult).toBe("function");
		// Proves a real re-registration pass happened (matching Alef's supervisor-swap.test.ts own
		// createCount()-style rigor: an object surviving unchanged would falsely pass a shallower
		// "is it defined and callable" check even if reload never actually re-ran anything).
		expect(after?.definition).not.toBe(before?.definition);
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

	// Not just permissions/availability.
	it("refreshVehicleToolAvailability re-evaluates the safety policy store too", async () => {
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

	// A denial never touches the client at all.
	it("an override of 'ask' gates execute() with a local confirm before invoke()", async () => {
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

	// No option needed to opt in.
	it("registerVehicleTools contributes to the shared safety registry unconditionally", async () => {
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
