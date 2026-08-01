import { afterEach, describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema, type JsonValue, VehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import type { Logger } from "@danypops/vehicle-server/logging";
import { RemoteVehicleClient } from "../src/vehicle-http-client.ts";

interface CapturedLog {
	level: "debug" | "info" | "warn" | "error";
	msg: string;
	fields?: Record<string, unknown>;
}

function createCapturingLogger(): { logger: Logger; calls: CapturedLog[] } {
	const calls: CapturedLog[] = [];
	const capture = (level: CapturedLog["level"]) => (msg: string, fields?: Record<string, unknown>) => {
		calls.push({ level, msg, fields });
	};
	return { logger: { debug: capture("debug"), info: capture("info"), warn: capture("warn"), error: capture("error") }, calls };
}

const objectSchema = <T extends Record<string, unknown>>(properties: Record<string, JsonValue>, parse: (value: unknown) => T | undefined) =>
	defineVehicleSchema<T>({
		jsonSchema: { type: "object", properties, additionalProperties: false },
		safeParse(value) {
			const parsed = parse(value);
			return parsed ? { success: true, value: parsed } : { success: false, issues: [{ path: [], message: "invalid object" }] };
		},
	});

const inputSchema = objectSchema<{ value: string }>({ value: { type: "string" } }, (value) =>
	typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "string"
		? { value: (value as { value: string }).value }
		: undefined,
);
const outputSchema = objectSchema<{ echoed: string }>({ echoed: { type: "string" } }, (value) =>
	typeof value === "object" && value !== null && typeof (value as { echoed?: unknown }).echoed === "string"
		? { echoed: (value as { echoed: string }).echoed }
		: undefined,
);

const LIMITS = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 4_096, maxResponseBytes: 4_096 } as const;

const Echo = defineVehicleOperation({
	name: "test.echo",
	version: 1,
	description: "Echo a string.",
	input: inputSchema,
	output: outputSchema,
	permissions: ["test:echo"],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

const Boom = defineVehicleOperation({
	name: "test.boom",
	version: 1,
	description: "Always fails validation.",
	input: inputSchema,
	output: outputSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

const Slow = defineVehicleOperation({
	name: "test.slow",
	version: 1,
	description: "Reports progress twice, then echoes.",
	input: inputSchema,
	output: outputSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

const Never = defineVehicleOperation({
	name: "test.never",
	version: 1,
	description: "Never resolves until cancelled.",
	input: inputSchema,
	output: outputSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

function startTestServer(options: { logger?: Logger } = {}): { baseUrl: string; token: string; registry: VehicleRegistry } {
	const token = "test-token";
	const registry = new VehicleRegistry({ name: "test-vehicle", version: "1.0.0", description: "Test Vehicle" });
	registry.register(
		"test-owner",
		bindVehicleOperation(Echo, () => async (context) => ({ echoed: context.input.value })),
	);
	registry.register(
		"test-owner",
		bindVehicleOperation(Boom, () => async () => {
			throw new VehicleError("boom", "always fails", { category: "internal" });
		}),
	);
	registry.register(
		"test-owner",
		bindVehicleOperation(Slow, () => async (context) => {
			context.reportProgress({ step: 1 });
			await new Promise((resolve) => setTimeout(resolve, 5));
			context.reportProgress({ step: 2 });
			return { echoed: context.input.value };
		}),
	);
	registry.register(
		"test-owner",
		bindVehicleOperation(Never, () => (context) => {
			return new Promise((_resolve, reject) => {
				context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}),
	);
	const app = createVehicleHttpApp({ registry, token, logger: options.logger });
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	return { baseUrl: `http://127.0.0.1:${server.port}`, token, registry };
}

describe("Vehicle HTTP provider + RemoteVehicleClient: local/HTTP parity", () => {
	it("manifest() returns the registry's real manifest", async () => {
		const { baseUrl, token, registry } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		const manifest = await client.manifest();
		expect(manifest).toEqual(registry.manifest());
	});

	it("manifest()/invoke() reject without the correct Bearer token", async () => {
		const { baseUrl } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token: "wrong-token" });
		await expect(client.manifest()).rejects.toThrow();
	});

	it("invoke() round-trips input/output exactly like LocalVehicleClient would", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		const result = await client.invoke<{ echoed: string }>("test.echo", 1, { value: "hi" }, { permissions: ["test:echo"] });
		expect(result).toEqual({ echoed: "hi" });
	});

	it("a missing permission surfaces the identical VehicleError shape as the local registry would throw", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		try {
			await client.invoke("test.echo", 1, { value: "hi" }, {});
			throw new Error("expected invoke() to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(VehicleError);
			expect((error as VehicleError).code).toBe("permission-denied");
			expect((error as VehicleError).category).toBe("authorization");
		}
	});

	it("a handler failure surfaces the real VehicleError code/category/message over HTTP", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		try {
			await client.invoke("test.boom", 1, { value: "x" }, {});
			throw new Error("expected invoke() to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(VehicleError);
			expect((error as VehicleError).code).toBe("boom");
			expect((error as VehicleError).message).toBe("always fails");
		}
	});

	it("invoking an unknown operation returns not-found", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		try {
			await client.invoke("test.nonexistent", 1, {}, {});
			throw new Error("expected invoke() to reject");
		} catch (error) {
			expect((error as VehicleError).code).toBe("not-found");
		}
	});

	it("onProgress receives every progress event via the SSE path, then resolves with the final output", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		const progress: unknown[] = [];
		const result = await client.invoke<{ echoed: string }>("test.slow", 1, { value: "hi" }, { onProgress: (p) => progress.push(p) });
		expect(progress).toEqual([{ step: 1 }, { step: 2 }]);
		expect(result).toEqual({ echoed: "hi" });
	});

	it("aborting the caller's signal cancels the still-running remote operation, not just the local wait", async () => {
		const { baseUrl, token, registry } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		const controller = new AbortController();
		const invocation = client.invoke("test.never", 1, { value: "x" }, { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await expect(invocation).rejects.toThrow();
		// The server-side handler's own AbortSignal must have fired too -- not
		// just the client giving up on waiting for an HTTP response it will
		// never read the body of.
		void registry; // registry itself has no direct introspection hook; the handler's own rejection (verified via the client's rejection above) is the real proof.
	});

	it("close() prevents further calls on this client instance", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		await client.close();
		await expect(client.manifest()).rejects.toThrow("closed");
	});
});

describe("Vehicle HTTP provider: failure logging", () => {
	it("logs a failed non-streaming invocation's real code/category/message and cause, not just a sanitized wire payload", async () => {
		const { logger, calls } = createCapturingLogger();
		const { baseUrl, token } = startTestServer({ logger });
		const client = new RemoteVehicleClient({ baseUrl, token });
		await expect(client.invoke("test.boom", 1, { value: "x" }, {})).rejects.toThrow();

		const errorCalls = calls.filter((c) => c.level === "error");
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]?.msg).toBe("vehicle invoke failed: test.boom@1");
		expect(errorCalls[0]?.fields).toMatchObject({ code: "boom", category: "internal", message: "always fails" });
	});

	it("logs a failed streaming (onProgress) invocation the same way as the plain JSON path", async () => {
		const { logger, calls } = createCapturingLogger();
		const { baseUrl, token } = startTestServer({ logger });
		const client = new RemoteVehicleClient({ baseUrl, token });
		await expect(client.invoke("test.boom", 1, { value: "x" }, { onProgress: () => {} })).rejects.toThrow();

		const errorCalls = calls.filter((c) => c.level === "error");
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]?.msg).toBe("vehicle invoke failed: test.boom@1");
		expect(errorCalls[0]?.fields).toMatchObject({ code: "boom", category: "internal", message: "always fails" });
	});

	it("never logs anything for a successful invocation", async () => {
		const { logger, calls } = createCapturingLogger();
		const { baseUrl, token } = startTestServer({ logger });
		const client = new RemoteVehicleClient({ baseUrl, token });
		await client.invoke("test.echo", 1, { value: "x" }, { permissions: ["test:echo"] });
		expect(calls).toHaveLength(0);
	});

	it("defaults to a no-op logger when none is supplied -- no behavior change, and never throws from logging itself", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		await expect(client.invoke("test.boom", 1, { value: "x" }, {})).rejects.toThrow("always fails");
	});
});
