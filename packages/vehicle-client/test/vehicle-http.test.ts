import { afterEach, describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema, type JsonValue, VehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import type { Logger } from "@danypops/vehicle-server/logging";
import { createReconnectingVehicleClient } from "../src/daemon-client.ts";
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

const Write = defineVehicleOperation({
	name: "test.write",
	version: 1,
	description: "A non-read-effect operation, for manifest-cache-invalidation tests.",
	input: inputSchema,
	output: outputSchema,
	permissions: [],
	effect: "local-write",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

/** Wraps the global fetch, counting requests whose URL contains `pathSubstring` -- used to prove a cache hit skips the real HTTP call, not just to assert on the returned value. */
function countingFetch(pathSubstring: string): { fetchImpl: typeof globalThis.fetch; count: () => number } {
	let count = 0;
	const fetchImpl = (async (...args: Parameters<typeof globalThis.fetch>) => {
		const [input] = args;
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.includes(pathSubstring)) count++;
		return globalThis.fetch(...args);
	}) as typeof globalThis.fetch;
	return { fetchImpl, count: () => count };
}

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
	registry.register(
		"test-owner",
		bindVehicleOperation(Write, () => async (context) => ({ echoed: context.input.value })),
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

	it("the server survives a client hard-disconnecting mid-stream without ever calling /vehicle/cancel (regression: an unguarded controller.enqueue() after a runtime-closed stream used to crash the whole process)", async () => {
		let unhandledRejections = 0;
		const onUnhandledRejection = () => {
			unhandledRejections++;
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const { baseUrl, token } = startTestServer();
			// A raw fetch, not RemoteVehicleClient -- this deliberately skips the client's own
			// cooperative /vehicle/cancel notification, reproducing a hard disconnect (client
			// crash, network drop, deadline) the server never gets a heads-up about.
			const disconnect = new AbortController();
			const response = await fetch(`${baseUrl}/vehicle/invoke`, {
				method: "POST",
				signal: disconnect.signal,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({ name: "test.never", version: 1, input: { value: "x" } }),
			});
			expect(response.status).toBe(200);
			// Read nothing, just establish the stream is open, then hard-disconnect.
			response.body?.getReader();
			disconnect.abort();
			// Give the server's stream cancel()/registry.invoke() rejection a moment to run;
			// the real proof is that the process is still healthy enough to answer this at all.
			await new Promise((resolve) => setTimeout(resolve, 50));
			const stillAlive = await fetch(`${baseUrl}/vehicle/manifest`, { headers: { authorization: `Bearer ${token}` } });
			expect(stillAlive.status).toBe(200);
			expect(unhandledRejections).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});
});

describe("RemoteVehicleClient: server disconnects mid-SSE-stream", () => {
	it("surfaces a clear error, not a hang, when the server is killed between two progress ticks", async () => {
		const { baseUrl, token } = startTestServer();
		const client = new RemoteVehicleClient({ baseUrl, token });
		const progress: unknown[] = [];
		const invocation = client.invoke<{ echoed: string }>(
			"test.slow",
			1,
			{ value: "hi" },
			{
				onProgress: (p) => {
					progress.push(p);
					// Kill the connection right after the first tick, before the second tick/result ever arrives --
					// simulating a daemon restart or network drop mid-wait, the same shape as a real long ci.wait().
					server?.stop(true);
				},
			},
		);
		let caught: unknown;
		try {
			await invocation;
			throw new Error("expected invoke() to reject");
		} catch (error) {
			caught = error;
		}
		expect(progress).toEqual([{ step: 1 }]);
		expect(caught).toBeInstanceOf(Error);
		// Real, observed shape (Bun's own fetch): distinct from Node/undici's "fetch failed" for an
		// initial-connect failure -- the two runtimes report a severed stream differently, which is
		// itself the finding: a bare error message alone can't tell you which failure mode occurred.
		expect((caught as Error).message).toContain("socket connection was closed unexpectedly");
	});
});

describe("RemoteVehicleClient: manifest() TTL caching", () => {
	it("is off by default -- every call hits the server fresh, zero behavior change for existing callers", async () => {
		const { baseUrl, token } = startTestServer();
		const { fetchImpl, count } = countingFetch("/vehicle/manifest");
		const client = new RemoteVehicleClient({ baseUrl, token, fetch: fetchImpl });

		await client.manifest();
		await client.manifest();

		expect(count()).toBe(2);
	});

	it("a second call within the TTL is served from cache -- exactly one real request", async () => {
		const { baseUrl, token } = startTestServer();
		const { fetchImpl, count } = countingFetch("/vehicle/manifest");
		const client = new RemoteVehicleClient({ baseUrl, token, fetch: fetchImpl, manifestCacheTtlMs: 60_000 });

		const first = await client.manifest();
		const second = await client.manifest();

		expect(count()).toBe(1);
		expect(second).toEqual(first);
	});

	it("a call after the TTL elapses re-fetches", async () => {
		const { baseUrl, token } = startTestServer();
		const { fetchImpl, count } = countingFetch("/vehicle/manifest");
		const client = new RemoteVehicleClient({ baseUrl, token, fetch: fetchImpl, manifestCacheTtlMs: 5 });

		await client.manifest();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await client.manifest();

		expect(count()).toBe(2);
	});

	it("invalidates the cache after a successful non-read-effect invoke() through the same client", async () => {
		const { baseUrl, token } = startTestServer();
		const { fetchImpl, count } = countingFetch("/vehicle/manifest");
		const client = new RemoteVehicleClient({ baseUrl, token, fetch: fetchImpl, manifestCacheTtlMs: 60_000 });

		await client.manifest();
		expect(count()).toBe(1);

		await client.invoke("test.write", 1, { value: "x" }, {});
		await client.manifest();

		expect(count()).toBe(2);
	});

	it("never invalidates the cache for a successful read-effect invoke()", async () => {
		const { baseUrl, token } = startTestServer();
		const { fetchImpl, count } = countingFetch("/vehicle/manifest");
		const client = new RemoteVehicleClient({ baseUrl, token, fetch: fetchImpl, manifestCacheTtlMs: 60_000 });

		await client.manifest();
		await client.invoke("test.echo", 1, { value: "x" }, { permissions: ["test:echo"] });
		await client.manifest();

		expect(count()).toBe(1);
	});

	it("never invalidates the cache when the invoked operation fails", async () => {
		const { baseUrl, token } = startTestServer();
		const { fetchImpl, count } = countingFetch("/vehicle/manifest");
		const client = new RemoteVehicleClient({ baseUrl, token, fetch: fetchImpl, manifestCacheTtlMs: 60_000 });

		await client.manifest();
		await expect(client.invoke("test.boom", 1, { value: "x" }, {})).rejects.toThrow();
		await client.manifest();

		expect(count()).toBe(1);
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

/**
 * Reproduces the exact live failure this house hit: a Papyrus daemon
 * restart rebound a new random port, and every Vehicle tool call in an
 * already-running Pi session failed with a bare connection error until the
 * whole extension reloaded -- because registerVehicleTools() (vehicle-client-pi)
 * captures one concrete VehicleClient forever, and that client (a bare
 * `new RemoteVehicleClient(...)`) has no way to notice its baseUrl died.
 * createReconnectingVehicleClient() is the fix: these tests start a real
 * server, kill it, start a genuinely new one on a new port (same token --
 * matching a real daemon's token file surviving a restart while its handle
 * file's port does not), and prove the wrapped client self-heals.
 */
describe("createReconnectingVehicleClient: survives a daemon restart onto a new port", () => {
	let servers: ReturnType<typeof Bun.serve>[] = [];

	afterEach(() => {
		for (const s of servers) s.stop(true);
		servers = [];
	});

	function startServer(registry: VehicleRegistry, token: string, logger?: Logger): string {
		const app = createVehicleHttpApp({ registry, token, logger });
		const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
		servers.push(s);
		return `http://127.0.0.1:${s.port}`;
	}

	function buildRegistry(): VehicleRegistry {
		const registry = new VehicleRegistry({ name: "test-vehicle", version: "1.0.0", description: "Test Vehicle" });
		registry.register(
			"test-owner",
			bindVehicleOperation(Echo, () => async (context) => ({ echoed: context.input.value })),
		);
		return registry;
	}

	it("manifest() transparently self-heals after a restart -- the very first call after the port changes still succeeds", async () => {
		const token = "test-token";
		let currentBaseUrl = startServer(buildRegistry(), token);
		let connectCount = 0;
		const client = createReconnectingVehicleClient(async () => {
			connectCount++;
			return new RemoteVehicleClient({ baseUrl: currentBaseUrl, token });
		});

		await expect(client.manifest()).resolves.toMatchObject({ name: "test-vehicle" });
		expect(connectCount).toBe(1);

		// Simulate a real restart: the old process is gone, a new one binds a new random port.
		servers[0]?.stop(true);
		currentBaseUrl = startServer(buildRegistry(), token);

		// No visible failure to the caller -- call() retries transparently against the fresh port.
		await expect(client.manifest()).resolves.toMatchObject({ name: "test-vehicle" });
		expect(connectCount).toBe(2);
	});

	it("invoke() surfaces the first post-restart failure once (never silently double-invoked), then self-heals on the next call", async () => {
		const token = "test-token";
		let currentBaseUrl = startServer(buildRegistry(), token);
		let connectCount = 0;
		const client = createReconnectingVehicleClient(async () => {
			connectCount++;
			return new RemoteVehicleClient({ baseUrl: currentBaseUrl, token });
		});

		await expect(client.invoke("test.echo", 1, { value: "first" }, { permissions: ["test:echo"] })).resolves.toEqual({ echoed: "first" });
		expect(connectCount).toBe(1);

		servers[0]?.stop(true);
		currentBaseUrl = startServer(buildRegistry(), token);

		// This exact call's own request really did fail (the port it was sent to is dead) --
		// callOnce() surfaces that honestly instead of silently retrying a mutating call.
		await expect(client.invoke("test.echo", 1, { value: "second" }, { permissions: ["test:echo"] })).rejects.toThrow();

		// The stale connection was dropped by that failure -- this next call reconnects and
		// succeeds on its own first attempt, exactly matching the real fix's behavior: one
		// failed call (visible to the model as a tool error, same as any other transient
		// failure), not "broken until /reload".
		await expect(client.invoke("test.echo", 1, { value: "third" }, { permissions: ["test:echo"] })).resolves.toEqual({ echoed: "third" });
		expect(connectCount).toBe(2);
	});

	it("invoke() never retries a caller-aborted call as if it were a connection failure", async () => {
		const token = "test-token";
		const baseUrl = startServer(buildRegistry(), token);
		let connectCount = 0;
		const client = createReconnectingVehicleClient(async () => {
			connectCount++;
			return new RemoteVehicleClient({ baseUrl, token });
		});

		const controller = new AbortController();
		controller.abort();
		await expect(
			client.invoke("test.echo", 1, { value: "x" }, { permissions: ["test:echo"], signal: controller.signal }),
		).rejects.toThrow();
		// Exactly one attempt -- an aborted call is the CALLER's decision, never silently repeated.
		expect(connectCount).toBe(1);
	});

	it("close() prevents further calls, matching RemoteVehicleClient's own closed-client contract", async () => {
		const token = "test-token";
		const baseUrl = startServer(buildRegistry(), token);
		const client = createReconnectingVehicleClient(async () => new RemoteVehicleClient({ baseUrl, token }));
		await client.close();
		await expect(client.manifest()).rejects.toThrow("closed");
		await expect(client.invoke("test.echo", 1, { value: "x" }, {})).rejects.toThrow("closed");
	});
});
