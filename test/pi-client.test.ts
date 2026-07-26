import { describe, expect, it } from "bun:test";
import { connectWithPolicy, createRetryingClient, type DaemonHandleLike, isLikelyStaleConnectionError } from "../src/pi-client.ts";

class FakeClient {
	constructor(public readonly id: number) {}
}

describe("isLikelyStaleConnectionError", () => {
	it("treats fetch()'s own TypeError as stale", () => {
		expect(isLikelyStaleConnectionError(new TypeError("fetch failed"))).toBe(true);
	});

	it("treats AbortError/TimeoutError as stale", () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(isLikelyStaleConnectionError(abort)).toBe(true);
		const timeout = new Error("timed out");
		timeout.name = "TimeoutError";
		expect(isLikelyStaleConnectionError(timeout)).toBe(true);
	});

	it("treats connection-refused/reset messages as stale", () => {
		expect(isLikelyStaleConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:1234"))).toBe(true);
		expect(isLikelyStaleConnectionError(new Error("socket hang up"))).toBe(true);
	});

	it("does not treat a plain domain-level error as stale", () => {
		expect(isLikelyStaleConnectionError(new Error("validation failed: missing field"))).toBe(false);
	});

	it("does not treat a non-Error value as stale", () => {
		expect(isLikelyStaleConnectionError("boom")).toBe(false);
		expect(isLikelyStaleConnectionError(undefined)).toBe(false);
	});
});

describe("createRetryingClient", () => {
	it("connects once and reuses the cached client across calls", async () => {
		let connectCount = 0;
		const client = createRetryingClient(async () => {
			connectCount++;
			return new FakeClient(connectCount);
		});

		const first = await client.call(async (c) => c.id);
		const second = await client.call(async (c) => c.id);
		expect(first).toBe(1);
		expect(second).toBe(1);
		expect(connectCount).toBe(1);
	});

	it("does not cache a failed connection attempt -- the very next call retries", async () => {
		let attempt = 0;
		const client = createRetryingClient(async () => {
			attempt++;
			if (attempt === 1) throw new Error("connect ECONNREFUSED");
			return new FakeClient(attempt);
		});

		await expect(client.call(async (c) => c.id)).rejects.toThrow("ECONNREFUSED");
		const result = await client.call(async (c) => c.id);
		expect(result).toBe(2);
	});

	it("retries exactly once against a freshly reconnected client on a stale-connection error", async () => {
		let connectCount = 0;
		const client = createRetryingClient(async () => {
			connectCount++;
			return new FakeClient(connectCount);
		});

		let operationCalls = 0;
		const result = await client.call(async (c) => {
			operationCalls++;
			if (operationCalls === 1) throw new TypeError("fetch failed");
			return c.id;
		});

		expect(result).toBe(2); // second (reconnected) client's id
		expect(connectCount).toBe(2);
		expect(operationCalls).toBe(2);
	});

	it("does not retry a genuine domain-level rejection -- propagates immediately", async () => {
		let connectCount = 0;
		const client = createRetryingClient(async () => {
			connectCount++;
			return new FakeClient(connectCount);
		});

		await expect(
			client.call(async () => {
				throw new Error("validation failed");
			}),
		).rejects.toThrow("validation failed");
		expect(connectCount).toBe(1); // never reconnected -- not a stale-connection error
	});

	it("surfaces the second attempt's own error after two consecutive stale-connection failures, not a synthetic message", async () => {
		let connectCount = 0;
		const client = createRetryingClient(async () => {
			connectCount++;
			return new FakeClient(connectCount);
		});

		await expect(
			client.call(async () => {
				throw new TypeError("fetch failed");
			}),
		).rejects.toThrow("fetch failed");
		expect(connectCount).toBe(2); // reconnected once before giving up
	});

	it("accepts a label option without changing normal call behavior", async () => {
		const client = createRetryingClient(async () => new FakeClient(1), { label: "Acme" });
		expect(await client.call(async (c) => c.id)).toBe(1);
	});

	it("reset() drops the cached client, forcing the next call() to reconnect", async () => {
		let connectCount = 0;
		const client = createRetryingClient(async () => {
			connectCount++;
			return new FakeClient(connectCount);
		});

		await client.call(async (c) => c.id);
		expect(connectCount).toBe(1);
		client.reset();
		await client.call(async (c) => c.id);
		expect(connectCount).toBe(2);
	});

	it("a custom isStaleConnectionError predicate overrides the default heuristic", async () => {
		let connectCount = 0;
		const client = createRetryingClient(
			async () => {
				connectCount++;
				return new FakeClient(connectCount);
			},
			{ isStaleConnectionError: (error) => error instanceof RangeError },
		);

		// Would be stale under the default heuristic (TypeError) but not under this custom one.
		await expect(
			client.call(async () => {
				throw new TypeError("fetch failed");
			}),
		).rejects.toThrow("fetch failed");
		expect(connectCount).toBe(1); // no retry -- custom predicate said this isn't stale
	});
});

const FAKE_HANDLE: DaemonHandleLike = { host: "127.0.0.1", port: 4242, pid: 1 };

describe("connectWithPolicy", () => {
	it("builds a client directly when a handle is already present -- never calls spawn", async () => {
		const spawn = () => {
			throw new Error("spawn should not be called");
		};
		const client = await connectWithPolicy({
			readHandle: () => FAKE_HANDLE,
			buildClient: (handle) => new FakeClient(handle.port),
			autoStart: true,
			spawn,
			fallbackMessage: "unreachable",
		});
		expect(client.id).toBe(4242);
	});

	it("fails closed with the fallback message by default (autoStart defaults to false) -- never spawns", async () => {
		let spawnCalls = 0;
		await expect(
			connectWithPolicy({
				readHandle: () => null,
				buildClient: (handle) => new FakeClient(handle.port),
				spawn: () => {
					spawnCalls++;
				},
				fallbackMessage: "start it with `acme serve`",
			}),
		).rejects.toThrow("start it with `acme serve`");
		expect(spawnCalls).toBe(0);
	});

	it("rejects autoStart:true with no spawn() provided, rather than silently failing closed", async () => {
		await expect(
			connectWithPolicy({
				readHandle: () => null,
				buildClient: (handle) => new FakeClient(handle.port),
				autoStart: true,
				fallbackMessage: "unreachable",
			}),
		).rejects.toThrow("autoStart is true but no spawn");
	});

	it("autoStart:true spawns once and polls until the handle appears, then builds the client", async () => {
		let spawnCalls = 0;
		let readCalls = 0;
		const client = await connectWithPolicy({
			readHandle: () => {
				readCalls++;
				return readCalls >= 3 ? FAKE_HANDLE : null; // appears on the 3rd poll
			},
			buildClient: (handle) => new FakeClient(handle.port),
			autoStart: true,
			spawn: () => {
				spawnCalls++;
			},
			fallbackMessage: "never started",
			pollIntervalMs: 1,
		});
		expect(spawnCalls).toBe(1);
		expect(client.id).toBe(4242);
	});

	it("autoStart:true gives up with the fallback message once startTimeoutMs elapses without a handle appearing", async () => {
		await expect(
			connectWithPolicy({
				readHandle: () => null, // never appears
				buildClient: (handle) => new FakeClient(handle.port),
				autoStart: true,
				spawn: () => {},
				fallbackMessage: "daemon failed to start automatically",
				startTimeoutMs: 20,
				pollIntervalMs: 5,
			}),
		).rejects.toThrow("daemon failed to start automatically");
	});
});
