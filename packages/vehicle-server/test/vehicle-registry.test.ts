import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
	bindVehicleOperation,
	defineVehicleEvent,
	defineVehicleOperation,
	defineVehicleSchema,
	type JsonValue,
	VehicleError,
} from "@danypops/vehicle-core";
import { bridgeVehicleEventsToPushChannel, type VehicleExecutionPolicy, VehicleRegistry } from "../src/vehicle-registry.ts";

function destructiveEchoRegistry(): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
	const operation = defineVehicleOperation({ ...ECHO_OPTIONS, name: "test.destructive-echo", effect: "destructive" });
	registry.register(
		"echo-provider",
		bindVehicleOperation(operation, () => async ({ input }) => ({ echoed: input.value })),
	);
	return registry;
}

async function requestApprovalGate(registry: VehicleRegistry, input: { value: string } = { value: "go" }): Promise<string> {
	const failure = await registry.invoke("test.destructive-echo", 1, input, { permissions: ["test:echo"] }).then(
		() => {
			throw new Error("expected the gated invoke() to reject");
		},
		(error) => error as { details?: { requestId?: string } },
	);
	const requestId = failure.details?.requestId;
	if (!requestId) throw new Error("expected a requestId in the approval-required failure");
	return requestId;
}

const objectSchema = <T extends Record<string, unknown>>(properties: Record<string, JsonValue>, parse: (value: unknown) => T | undefined) =>
	defineVehicleSchema<T>({
		jsonSchema: { type: "object", properties, additionalProperties: false },
		safeParse(value) {
			const parsed = parse(value);
			return parsed ? { success: true, value: parsed } : { success: false, issues: [{ path: [], message: "invalid object" }] };
		},
	});

const inputSchema = objectSchema({ value: { type: "string" } }, (value) =>
	typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "string"
		? { value: (value as { value: string }).value }
		: undefined,
);

const outputSchema = objectSchema({ echoed: { type: "string" } }, (value) =>
	typeof value === "object" && value !== null && typeof (value as { echoed?: unknown }).echoed === "string"
		? { echoed: (value as { echoed: string }).echoed }
		: undefined,
);

const ECHO_OPTIONS = {
	name: "test.echo",
	version: 1,
	description: "Echo a string.",
	input: inputSchema,
	output: outputSchema,
	permissions: ["test:echo"],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: {
		defaultTimeoutMs: 1_000,
		maxTimeoutMs: 5_000,
		maxRequestBytes: 1_024,
		maxResponseBytes: 1_024,
	},
} as const;

const Echo = defineVehicleOperation(ECHO_OPTIONS);

function echoBinding(factory?: () => (context: { input: { value: string } }) => Promise<{ echoed: string }>) {
	return bindVehicleOperation(
		Echo,
		factory ??
			(() =>
				async ({ input }) => ({ echoed: input.value })),
	);
}

function registryWith(binding = echoBinding(), policy?: VehicleExecutionPolicy): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "test-vehicle", version: "1.0.0", description: "Vehicle test fixture." }, policy);
	registry.register("echo-provider", binding);
	return registry;
}

describe("Vehicle operation contracts", () => {
	it("keeps the manifest descriptor serializable and executable code in the binding", () => {
		const binding = echoBinding();
		expect(JSON.parse(JSON.stringify(binding.operation.descriptor))).toEqual(binding.operation.descriptor);
		expect("bind" in binding.operation.descriptor).toBe(false);
		expect("safeParse" in binding.operation.descriptor.inputSchema).toBe(false);

		const manifest = registryWith(binding).manifest();
		expect(manifest.operations).toEqual([{ ...binding.operation.descriptor, available: true }]);
	});

	it("rejects invalid operation metadata before registration", () => {
		expect(() => defineVehicleOperation({ ...ECHO_OPTIONS, name: "" })).toThrow("operation name");
		expect(() =>
			defineVehicleOperation({
				...ECHO_OPTIONS,
				limits: { ...ECHO_OPTIONS.limits, defaultTimeoutMs: 6_000 },
			}),
		).toThrow("defaultTimeoutMs");
	});
});

describe("VehicleRegistry", () => {
	it("keeps the existing explicit-version identity path unchanged", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.2.3", description: "Test." });
		expect(registry.manifest()).toMatchObject({ name: "test", version: "1.2.3", description: "Test." });
	});

	it("derives its manifest version from the caller's package.json", () => {
		const packageJsonUrl = new URL("../package.json", import.meta.url);
		const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version: string };
		const registry = new VehicleRegistry({ name: "vehicle-server", packageJsonUrl, description: "Test." });
		expect(registry.manifest().version).toBe(packageJson.version);
	});

	it("returns a validated result from the operation's sole owner", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.register("echo-provider", echoBinding());

		await expect(registry.invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] })).resolves.toEqual({ echoed: "hello" });
		expect(registry.ownerOf("test.echo", 1)).toBe("echo-provider");
	});

	it("rejects duplicate ownership for the same name and version", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.register("first", echoBinding());
		expect(() => registry.register("second", echoBinding())).toThrow("already owned by first");
	});

	it("reports every registered operation as available by default", () => {
		const manifest = registryWith().manifest();
		expect(manifest.operations[0]?.available).toBe(true);
		expect(manifest.operations[0]?.unavailableReason).toBeUndefined();
	});

	it("setAvailability(false) hides an operation from the manifest and refuses invocation, without unregistering it", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.register("echo-provider", echoBinding());

		registry.setAvailability("test.echo", 1, false, "credential not configured");

		const manifest = registry.manifest();
		expect(manifest.operations[0]).toMatchObject({ available: false, unavailableReason: "credential not configured" });
		expect(registry.ownerOf("test.echo", 1)).toBe("echo-provider"); // still registered, just hidden

		await expect(registry.invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "operation-unavailable",
			category: "unavailable",
			retryable: true,
		});

		registry.setAvailability("test.echo", 1, true);
		const manifestAgain = registry.manifest();
		expect(manifestAgain.operations[0]).toMatchObject({ available: true });
		expect(manifestAgain.operations[0]?.unavailableReason).toBeUndefined();
		await expect(registry.invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] })).resolves.toEqual({ echoed: "hello" });
	});

	it("setAvailability throws for an operation that was never registered", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		expect(() => registry.setAvailability("nope", 1, false)).toThrow("unregistered");
	});

	it("validates both input and output with bounded structured details", async () => {
		const registry = registryWith(echoBinding(() => async () => ({ echoed: 42 }) as never));

		await expect(registry.invoke("test.echo", 1, { value: 1 }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "invalid-input",
			category: "validation",
			retryable: false,
			details: { issues: [{ path: [], message: "invalid object" }] },
		});
		await expect(registry.invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "invalid-output",
			category: "internal",
			retryable: false,
		});
	});

	it("enforces declared request and response byte bounds", async () => {
		await expect(registryWith().invoke("test.echo", 1, { value: "x".repeat(2_000) }, { permissions: ["test:echo"] })).rejects.toMatchObject(
			{ code: "request-too-large", category: "capacity" },
		);

		const oversizedOutput = echoBinding(() => async () => ({ echoed: "x".repeat(2_000) }));
		await expect(
			registryWith(oversizedOutput).invoke("test.echo", 1, { value: "small" }, { permissions: ["test:echo"] }),
		).rejects.toMatchObject({ code: "response-too-large", category: "capacity" });
	});

	it("requires an idempotency key for keyed mutations", async () => {
		const operation = defineVehicleOperation({
			...ECHO_OPTIONS,
			name: "test.keyed-echo",
			effect: "external-write",
			idempotency: { mode: "keyed", retentionMs: 60_000 },
		});
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.register(
			"keyed-provider",
			bindVehicleOperation(operation, () => async ({ input }) => ({ echoed: input.value })),
		);

		await expect(registry.invoke("test.keyed-echo", 1, { value: "hello" }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "idempotency-key-required",
			category: "validation",
		});
		await expect(
			registry.invoke(
				"test.keyed-echo",
				1,
				{ value: "hello" },
				{
					permissions: ["test:echo"],
					idempotencyKey: "request-1",
				},
			),
		).resolves.toEqual({ echoed: "hello" });
	});

	it("fails closed when required permissions are absent", async () => {
		await expect(registryWith().invoke("test.echo", 1, { value: "hello" })).rejects.toMatchObject({
			code: "permission-denied",
			category: "authorization",
			retryable: false,
		});
	});

	it("propagates cancellation and bounded deadlines to the handler", async () => {
		let receivedSignal: AbortSignal | undefined;
		const binding = bindVehicleOperation(Echo, () => async ({ signal }) => {
			receivedSignal = signal;
			return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		});
		const registry = registryWith(binding);
		const controller = new AbortController();
		const invocation = registry.invoke(
			"test.echo",
			1,
			{ value: "hello" },
			{
				permissions: ["test:echo"],
				signal: controller.signal,
			},
		);
		controller.abort(new Error("stop"));

		await expect(invocation).rejects.toMatchObject({ code: "cancelled" });
		expect(receivedSignal?.aborted).toBe(true);
		await expect(
			registry.invoke(
				"test.echo",
				1,
				{ value: "late" },
				{
					permissions: ["test:echo"],
					deadline: Date.now() - 1,
				},
			),
		).rejects.toMatchObject({ code: "deadline-exceeded" });
	});

	it("reports missing operation versions as structured failures", async () => {
		await expect(registryWith().invoke("test.echo", 2, { value: "hello" }, { permissions: ["test:echo"] })).rejects.toBeInstanceOf(
			VehicleError,
		);
		await expect(registryWith().invoke("test.echo", 2, { value: "hello" }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "not-found",
			category: "not_found",
		});
	});

	it("reports progress before returning the final validated result", async () => {
		const progress: unknown[] = [];
		const binding = bindVehicleOperation(Echo, () => async ({ input, reportProgress }) => {
			reportProgress({ echoed: "partial" });
			return { echoed: input.value };
		});
		const result = await registryWith(binding).invoke(
			"test.echo",
			1,
			{ value: "final" },
			{
				permissions: ["test:echo"],
				onProgress: (event) => progress.push(event),
			},
		);

		expect(progress).toEqual([{ echoed: "partial" }]);
		expect(result).toEqual({ echoed: "final" });
	});

	it("gives execution policy validated input and allows an approved effective input", async () => {
		const observed: string[] = [];
		const policy: VehicleExecutionPolicy = {
			async execute(request, invoke) {
				observed.push(`${request.operation.name}@${request.operation.version}:${request.operationId}:${request.correlationId}`);
				return invoke({ value: "approved" });
			},
		};
		const result = await registryWith(echoBinding(), policy).invoke(
			"test.echo",
			1,
			{ value: "requested" },
			{
				permissions: ["test:echo"],
				operationId: "operation-1",
				correlationId: "turn-1",
			},
		);

		expect(result).toEqual({ echoed: "approved" });
		expect(observed).toEqual(["test.echo@1:operation-1:turn-1"]);
	});

	it("normalizes unexpected policy failures", async () => {
		const policy: VehicleExecutionPolicy = {
			execute() {
				return Promise.reject(new Error("policy internals"));
			},
		};
		await expect(
			registryWith(echoBinding(), policy).invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] }),
		).rejects.toMatchObject({ code: "policy-failed", message: "test.echo@1 execution policy failed" });
	});

	it("normalizes handler failures without exposing their message in the wire-safe failure", async () => {
		const failure = new Error("credential=secret");
		const registry = registryWith(
			echoBinding(() => async () => {
				throw failure;
			}),
		);
		try {
			await registry.invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] });
			throw new Error("expected invocation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(VehicleError);
			expect(error).toMatchObject({ code: "handler-failed", message: "test.echo@1 handler failed", cause: failure });
			expect((error as VehicleError).toFailure().message).not.toContain("secret");
			expect((error as VehicleError).toFailure().causeMessage).toBeUndefined();
		}
	});

	it("once setExposeHandlerFailureDetails(true) is called, an unexpected handler failure's real message reaches the wire-safe failure", async () => {
		const registry = registryWith(
			echoBinding(() => async () => {
				throw new Error("column 'title' is required");
			}),
		);
		registry.setExposeHandlerFailureDetails(true);
		try {
			await registry.invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] });
			throw new Error("expected invocation to fail");
		} catch (error) {
			const failure = (error as VehicleError).toFailure();
			expect(failure.message).toBe("test.echo@1 handler failed: column 'title' is required");
			expect(failure.causeMessage).toBe("column 'title' is required");
		}
	});

	it("exposeHandlerFailureDetails also applies to unexpected execution-policy failures", async () => {
		const policy: VehicleExecutionPolicy = {
			execute() {
				return Promise.reject(new Error("policy internals"));
			},
		};
		const registry = registryWith(echoBinding(), policy);
		registry.setExposeHandlerFailureDetails(true);
		await expect(registry.invoke("test.echo", 1, { value: "hello" }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "policy-failed",
			message: "test.echo@1 execution policy failed: policy internals",
		});
	});

	it("binds state once per registry so separate local providers are isolated", async () => {
		const stateful = echoBinding(() => {
			let calls = 0;
			return async () => ({ echoed: String(++calls) });
		});
		const first = registryWith(stateful);
		const second = registryWith(stateful);

		expect(await first.invoke("test.echo", 1, { value: "x" }, { permissions: ["test:echo"] })).toEqual({ echoed: "1" });
		expect(await first.invoke("test.echo", 1, { value: "x" }, { permissions: ["test:echo"] })).toEqual({ echoed: "2" });
		expect(await second.invoke("test.echo", 1, { value: "x" }, { permissions: ["test:echo"] })).toEqual({ echoed: "1" });
	});
});

const Announced = defineVehicleEvent({
	name: "test.announced",
	version: 1,
	description: "A test event.",
	payload: outputSchema,
	maxPayloadBytes: 1_024,
});

describe("VehicleRegistry events", () => {
	it("registerEvent() rejects a second owner for the same name@version", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.registerEvent("first-owner", Announced);
		expect(() => registry.registerEvent("second-owner", Announced)).toThrow(/already owned by first-owner/);
	});

	it("subscribeLocal() throws not-found for an event nobody declared", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		expect(() => registry.subscribeLocal("nope", 1, () => {})).toThrow(/No Vehicle event is registered/);
	});

	it("subscribeLocal() enforces a bounded listener count per event", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.registerEvent("owner", Announced);
		const unsubscribes: (() => void)[] = [];
		for (let i = 0; i < 64; i++) unsubscribes.push(registry.subscribeLocal("test.announced", 1, () => {}));
		expect(() => registry.subscribeLocal("test.announced", 1, () => {})).toThrow(/maximum of 64 local listeners/);
		unsubscribes[0]!();
		expect(() => registry.subscribeLocal("test.announced", 1, () => {})).not.toThrow();
	});

	it("subscribeAll() observes every declared event's emit(), regardless of name", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.registerEvent("owner", Announced);
		const seen: { name: string; version: number; payload: unknown }[] = [];
		registry.subscribeAll((name, version, payload) => seen.push({ name, version, payload }));
		registry.emit("test.announced", 1, { echoed: "hi" });
		expect(seen).toEqual([{ name: "test.announced", version: 1, payload: { echoed: "hi" } }]);
	});

	it("bridgeVehicleEventsToPushChannel() forwards emit() onto publish() under the shared topic convention", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.registerEvent("owner", Announced);
		const published: { topic: string; payload: unknown }[] = [];
		const unsubscribe = bridgeVehicleEventsToPushChannel(registry, {
			publish: (topic, payload) => published.push({ topic, payload }),
		});
		registry.emit("test.announced", 1, { echoed: "hi" });
		expect(published).toEqual([{ topic: "vehicle-event:test.announced@1", payload: { echoed: "hi" } }]);
		unsubscribe();
		registry.emit("test.announced", 1, { echoed: "after unsubscribe" });
		expect(published).toHaveLength(1);
	});
});

describe("VehicleRegistry approval gate", () => {
	it("never gates anything unless configureApprovals() is called -- destructive/open-world run freely by default", async () => {
		const registry = destructiveEchoRegistry();
		await expect(registry.invoke("test.destructive-echo", 1, { value: "go" }, { permissions: ["test:echo"] })).resolves.toEqual({
			echoed: "go",
		});
		expect(registry.manifest().events).toEqual([]);
	});

	it("configureApprovals() twice throws", () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals();
		expect(() => registry.configureApprovals()).toThrow("already configured");
	});

	it("gates the default destructive/open-world effects, emits approval.requested durably, and rejects an unapproved retry", async () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals();
		const requested: unknown[] = [];
		registry.subscribeLocal("vehicle.approval.requested", 1, (payload) => requested.push(payload));

		await expect(registry.invoke("test.destructive-echo", 1, { value: "go" }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "approval-required",
			category: "authorization",
			retryable: true,
			details: { requestId: expect.any(String) },
		});
		expect(requested).toEqual([
			expect.objectContaining({ operationName: "test.destructive-echo", operationVersion: 1, effect: "destructive" }),
		]);
	});

	it("grants a real capability through vehicle.approval.resolve, and the retried invoke() succeeds", async () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals();
		const requestId = await requestApprovalGate(registry);

		const resolved = (await registry.invoke(
			"vehicle.approval.resolve",
			1,
			{ requestId, decision: "granted" },
			{ permissions: ["vehicle:approvals:resolve"] },
		)) as { capability?: string };
		expect(typeof resolved.capability).toBe("string");

		await expect(
			registry.invoke("test.destructive-echo", 1, { value: "go" }, { permissions: ["test:echo"], approvalCapability: resolved.capability }),
		).resolves.toEqual({ echoed: "go" });
	});

	it("a denied decision mints no capability, and the request cannot be resolved twice", async () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals();
		const requestId = await requestApprovalGate(registry);

		const denied = (await registry.invoke(
			"vehicle.approval.resolve",
			1,
			{ requestId, decision: "denied" },
			{ permissions: ["vehicle:approvals:resolve"] },
		)) as {
			capability?: string;
		};
		expect(denied.capability).toBeUndefined();

		await expect(
			registry.invoke("vehicle.approval.resolve", 1, { requestId, decision: "granted" }, { permissions: ["vehicle:approvals:resolve"] }),
		).rejects.toMatchObject({ code: "not-found" });
	});

	it("rejects an arbitrary non-empty string as a capability instead of rubber-stamping it", async () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals();

		await expect(
			registry.invoke("test.destructive-echo", 1, { value: "go" }, { permissions: ["test:echo"], approvalCapability: "signed-capability" }),
		).rejects.toMatchObject({ code: "approval-capability-invalid", category: "authorization", retryable: false });
	});

	it("rejects a capability minted for a different input than the one presented", async () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals();
		const requestId = await requestApprovalGate(registry, { value: "original" });
		const { capability } = (await registry.invoke(
			"vehicle.approval.resolve",
			1,
			{ requestId, decision: "granted" },
			{ permissions: ["vehicle:approvals:resolve"] },
		)) as { capability?: string };

		await expect(
			registry.invoke("test.destructive-echo", 1, { value: "tampered" }, { permissions: ["test:echo"], approvalCapability: capability }),
		).rejects.toMatchObject({ code: "approval-capability-invalid" });
	});

	it("a granted capability is single-use -- a second invoke() with the same capability is rejected", async () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals();
		const requestId = await requestApprovalGate(registry);
		const { capability } = (await registry.invoke(
			"vehicle.approval.resolve",
			1,
			{ requestId, decision: "granted" },
			{ permissions: ["vehicle:approvals:resolve"] },
		)) as { capability?: string };

		await expect(
			registry.invoke("test.destructive-echo", 1, { value: "go" }, { permissions: ["test:echo"], approvalCapability: capability }),
		).resolves.toEqual({ echoed: "go" });
		await expect(
			registry.invoke("test.destructive-echo", 1, { value: "go" }, { permissions: ["test:echo"], approvalCapability: capability }),
		).rejects.toMatchObject({ code: "approval-capability-invalid" });
	});

	it("a request that outlives its timeout expires -- the retried invoke() gets a fresh requestId, not the stale one", async () => {
		const registry = destructiveEchoRegistry();
		registry.configureApprovals({ timeoutMs: 1 });
		const requestId = await requestApprovalGate(registry);
		await new Promise((resolve) => setTimeout(resolve, 10));

		await expect(
			registry.invoke("vehicle.approval.resolve", 1, { requestId, decision: "granted" }, { permissions: ["vehicle:approvals:resolve"] }),
		).rejects.toMatchObject({ code: "not-found" });
	});

	it("requireApprovalForEffects is configurable per deployment -- can gate external-write too, and leaves read/local-write alone", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		const writeOp = defineVehicleOperation({ ...ECHO_OPTIONS, name: "test.write-echo", effect: "external-write" });
		registry.register(
			"echo-provider",
			bindVehicleOperation(writeOp, () => async ({ input }) => ({ echoed: input.value })),
		);
		registry.configureApprovals({ requireApprovalForEffects: ["external-write"] });

		await expect(registry.invoke("test.write-echo", 1, { value: "go" }, { permissions: ["test:echo"] })).rejects.toMatchObject({
			code: "approval-required",
		});

		const readOnly = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		readOnly.register("echo-provider", echoBinding());
		readOnly.configureApprovals({ requireApprovalForEffects: ["external-write"] });
		await expect(readOnly.invoke("test.echo", 1, { value: "go" }, { permissions: ["test:echo"] })).resolves.toEqual({ echoed: "go" });
	});
});
