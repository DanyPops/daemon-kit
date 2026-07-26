import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
	PiVehicleInvocationError,
	registerVehicleTools,
	type PiVehicleToolDetails,
} from "../src/vehicle-pi.ts";
import type {
	VehicleClient,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleOperationDescriptor,
} from "../src/vehicle.ts";
import { VehicleError } from "../src/vehicle.ts";

const limits = {
	defaultTimeoutMs: 1_000,
	maxTimeoutMs: 5_000,
	maxRequestBytes: 1_024,
	maxResponseBytes: 1_024,
};

function operation(
	name: string,
	version = 1,
	overrides: Partial<VehicleOperationDescriptor> = {},
): VehicleOperationDescriptor {
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

	constructor(readonly value: VehicleManifest) {}

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

function manifest(operations: readonly VehicleOperationDescriptor[]): VehicleManifest {
	return { name: "test-vehicle", version: "1.0.0", description: "Test Vehicle.", operations };
}

function fakePi(existingNames: string[] = []) {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		getAllTools() {
			return existingNames.map((name) => ({ name }));
		},
		on(name: string, handler: (...args: never[]) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers };
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
			{ toolName: "issues_search", operationName: "issues.search", operationVersion: 1 },
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
});
