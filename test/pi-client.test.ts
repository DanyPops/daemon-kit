import { describe, expect, it } from "bun:test";
import { connectWithPolicy, connectWithVersionCheck, createRetryingClient, type DaemonHandleLike, isLikelyStaleConnectionError, spawnDetachedDaemon, type SpawnPlatformOptions } from "../src/pi-client.ts";

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

	it("circuit breaker: short-circuits after sustained connect failures instead of retrying every call", async () => {
		let connectCount = 0;
		const client = createRetryingClient<FakeClient>(
			async () => {
				connectCount++;
				throw new Error(`connect ECONNREFUSED attempt ${connectCount}`);
			},
			{ circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 } },
		);

		await expect(client.call(async (c) => c.id)).rejects.toThrow("attempt 1");
		await expect(client.call(async (c) => c.id)).rejects.toThrow("attempt 2");
		await expect(client.call(async (c) => c.id)).rejects.toThrow("attempt 3");
		expect(connectCount).toBe(3);
		expect(client.breakerState().open).toBe(true);

		// Breaker is open: the 4th call must fail immediately from the cached
		// last error, without invoking connect() a 4th time.
		await expect(client.call(async (c) => c.id)).rejects.toThrow("attempt 3");
		expect(connectCount).toBe(3);
	});

	it("circuit breaker: a single transient connect failure does not trip it", async () => {
		let connectCount = 0;
		const client = createRetryingClient<FakeClient>(
			async () => {
				connectCount++;
				if (connectCount === 1) throw new Error("connect ECONNREFUSED");
				return new FakeClient(connectCount);
			},
			{ circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 } },
		);

		await expect(client.call(async (c) => c.id)).rejects.toThrow("ECONNREFUSED");
		expect(client.breakerState().open).toBe(false);
		expect(await client.call(async (c) => c.id)).toBe(2);
		expect(client.breakerState().consecutiveFailures).toBe(0);
	});

	it("circuit breaker: allows one probe attempt after cooldown elapses, and recovers on success", async () => {
		let connectCount = 0;
		const client = createRetryingClient<FakeClient>(
			async () => {
				connectCount++;
				if (connectCount <= 2) throw new Error(`fail ${connectCount}`);
				return new FakeClient(connectCount);
			},
			{ circuitBreaker: { failureThreshold: 2, cooldownMs: 10 } },
		);

		await expect(client.call(async (c) => c.id)).rejects.toThrow("fail 1");
		await expect(client.call(async (c) => c.id)).rejects.toThrow("fail 2");
		expect(client.breakerState().open).toBe(true);

		// Still within the cooldown window -- short-circuits without a new connect attempt.
		await expect(client.call(async (c) => c.id)).rejects.toThrow("fail 2");
		expect(connectCount).toBe(2);

		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(await client.call(async (c) => c.id)).toBe(3);
		expect(client.breakerState().open).toBe(false);
		expect(client.breakerState().consecutiveFailures).toBe(0);
	});

	it("circuit breaker: reset() clears breaker state immediately, even mid-cooldown", async () => {
		let connectCount = 0;
		const client = createRetryingClient<FakeClient>(
			async () => {
				connectCount++;
				if (connectCount <= 2) throw new Error(`fail ${connectCount}`);
				return new FakeClient(connectCount);
			},
			{ circuitBreaker: { failureThreshold: 2, cooldownMs: 10_000 } },
		);

		await expect(client.call(async (c) => c.id)).rejects.toThrow("fail 1");
		await expect(client.call(async (c) => c.id)).rejects.toThrow("fail 2");
		expect(client.breakerState().open).toBe(true);

		client.reset();
		expect(client.breakerState().open).toBe(false);
		expect(await client.call(async (c) => c.id)).toBe(3);
	});

	it("circuit breaker: circuitBreaker:false restores unthrottled retry-every-call behavior", async () => {
		let connectCount = 0;
		const client = createRetryingClient<FakeClient>(
			async () => {
				connectCount++;
				throw new Error(`fail ${connectCount}`);
			},
			{ circuitBreaker: false },
		);

		for (let i = 1; i <= 5; i++) {
			await expect(client.call(async (c) => c.id)).rejects.toThrow(`fail ${i}`);
		}
		expect(connectCount).toBe(5);
		expect(client.breakerState().open).toBe(false);
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
const REPLACEMENT_HANDLE: DaemonHandleLike = { host: "127.0.0.1", port: 5555, pid: 2 };

interface VersionedFakeClient {
	port: number;
	version: string;
}

describe("spawnDetachedDaemon", () => {
	it("passes detached+ignored stdio on every platform, with no windowsHide on non-Windows", () => {
		let captured: { command: string; args: string[]; options: SpawnPlatformOptions } | undefined;
		spawnDetachedDaemon({
			binPath: "/path/to/cli.ts",
			args: ["serve"],
			platform: "linux",
			spawn: (command, args, options) => {
				captured = { command, args, options };
			},
		});
		expect(captured?.command).toBe("/path/to/cli.ts");
		expect(captured?.args).toEqual(["serve"]);
		expect(captured?.options.detached).toBe(true);
		expect(captured?.options.stdio).toBe("ignore");
		expect(captured?.options.windowsHide).toBeUndefined();
	});

	it("adds windowsHide:true on win32 so a silent auto-spawn does not pop a console window", () => {
		let captured: SpawnPlatformOptions | undefined;
		spawnDetachedDaemon({
			binPath: "C:\\daemon\\cli.js",
			platform: "win32",
			spawn: (_command, _args, options) => {
				captured = options;
			},
		});
		expect(captured?.windowsHide).toBe(true);
		expect(captured?.detached).toBe(true);
	});

	it("forwards the provided env through to spawn", () => {
		let capturedEnv: Record<string, string | undefined> | undefined;
		spawnDetachedDaemon({
			binPath: "/cli.ts",
			platform: "darwin",
			env: { FOO: "bar" },
			spawn: (_command, _args, options) => {
				capturedEnv = options.env;
			},
		});
		expect(capturedEnv).toEqual({ FOO: "bar" });
	});

	it("defaults args to an empty array when omitted", () => {
		let capturedArgs: string[] | undefined;
		spawnDetachedDaemon({
			binPath: "/cli.ts",
			platform: "linux",
			spawn: (_command, args) => {
				capturedArgs = args;
			},
		});
		expect(capturedArgs).toEqual([]);
	});
});

describe("connectWithVersionCheck", () => {
	it("returns the client unchanged when the running daemon's version already matches -- no kill, no respawn", async () => {
		let spawnCalls = 0;
		let killCalls = 0;
		const client = await connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
			{
				readHandle: () => FAKE_HANDLE,
				buildClient: (handle) => ({ port: handle.port, version: "1.2.0" }),
				autoStart: true,
				spawn: () => {
					spawnCalls++;
				},
				fallbackMessage: "unreachable",
			},
			{
				expectedVersion: "1.2.0",
				readVersion: async (c) => c.version,
				killStaleProcess: () => {
					killCalls++;
				},
			},
		);
		expect(client.port).toBe(4242);
		expect(spawnCalls).toBe(0);
		expect(killCalls).toBe(0);
	});

	it("kills and replaces a version-mismatched daemon transparently, returning the fresh client", async () => {
		let currentHandle: DaemonHandleLike | null = FAKE_HANDLE;
		let spawnCalls = 0;
		let killCalls = 0;
		let shutdownRequests = 0;

		const client = await connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
			{
				readHandle: () => currentHandle,
				buildClient: (handle) => ({ port: handle.port, version: handle.pid === 1 ? "1.0.0" : "1.2.0" }),
				autoStart: true,
				spawn: () => {
					spawnCalls++;
					currentHandle = REPLACEMENT_HANDLE;
				},
				fallbackMessage: "unreachable",
			},
			{
				expectedVersion: "1.2.0",
				readVersion: async (c) => c.version,
				requestShutdown: async () => {
					shutdownRequests++;
					currentHandle = null; // graceful shutdown clears the handle immediately
				},
				killStaleProcess: () => {
					killCalls++;
				},
				shutdownPollIntervalMs: 1,
			},
		);

		expect(client.version).toBe("1.2.0");
		expect(client.port).toBe(5555);
		expect(shutdownRequests).toBe(1);
		expect(spawnCalls).toBe(1);
	});

	it("falls back to killStaleProcess when requestShutdown is absent or fails, and still replaces the daemon", async () => {
		let currentHandle: DaemonHandleLike | null = FAKE_HANDLE;
		let killCalls = 0;

		const client = await connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
			{
				readHandle: () => currentHandle,
				buildClient: (handle) => ({ port: handle.port, version: handle.pid === 1 ? "1.0.0" : "1.2.0" }),
				autoStart: true,
				spawn: () => {
					currentHandle = REPLACEMENT_HANDLE;
				},
				fallbackMessage: "unreachable",
			},
			{
				expectedVersion: "1.2.0",
				readVersion: async (c) => c.version,
				killStaleProcess: () => {
					killCalls++;
					currentHandle = null; // simulates the process actually dying and removing its handle
				},
				shutdownPollIntervalMs: 1,
			},
		);

		expect(client.version).toBe("1.2.0");
		expect(killCalls).toBe(1);
	});

	it("refuses to kill a stale daemon when no spawn() is configured to replace it", async () => {
		let killCalls = 0;
		await expect(
			connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
				{
					readHandle: () => FAKE_HANDLE,
					buildClient: (handle) => ({ port: handle.port, version: "1.0.0" }),
					fallbackMessage: "daemon not running",
				},
				{
					expectedVersion: "1.2.0",
					readVersion: async (c) => c.version,
					killStaleProcess: () => {
						killCalls++;
					},
				},
			),
		).rejects.toThrow(/no spawn\(\) is configured/);
		expect(killCalls).toBe(0);
	});

	it("propagates a readVersion() failure unchanged -- an inconclusive read never triggers a kill", async () => {
		let killCalls = 0;
		await expect(
			connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
				{
					readHandle: () => FAKE_HANDLE,
					buildClient: (handle) => ({ port: handle.port, version: "1.0.0" }),
					autoStart: true,
					spawn: () => {},
					fallbackMessage: "unreachable",
				},
				{
					expectedVersion: "1.2.0",
					readVersion: async () => {
						throw new Error("health endpoint unreachable");
					},
					killStaleProcess: () => {
						killCalls++;
					},
				},
			),
		).rejects.toThrow("health endpoint unreachable");
		expect(killCalls).toBe(0);
	});
});

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
