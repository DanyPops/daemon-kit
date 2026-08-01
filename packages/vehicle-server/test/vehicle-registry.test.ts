import { describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema, type JsonValue, VehicleError } from "@danypops/vehicle-core";
import { type VehicleExecutionPolicy, VehicleRegistry } from "../src/vehicle-registry.ts";

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
		}
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
