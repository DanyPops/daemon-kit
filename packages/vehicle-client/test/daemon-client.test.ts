import { afterEach, describe, expect, it } from "bun:test";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import {
	connectPushChannel,
	connectWithPolicy,
	connectWithVersionCheck,
	createRetryingClient,
	type DaemonHandleLike,
	daemonStatus,
	isLikelyStaleConnectionError,
	type SpawnPlatformOptions,
	spawnDetachedDaemon,
} from "../src/daemon-client.ts";

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

	describe("callOnce", () => {
		it("runs the operation once against a freshly connected client, same as call() on first attempt", async () => {
			let connectCount = 0;
			const client = createRetryingClient(async () => {
				connectCount++;
				return new FakeClient(connectCount);
			});
			expect(await client.callOnce(async (c) => c.id)).toBe(1);
			expect(connectCount).toBe(1);
		});

		it("never retries the operation itself on a stale-connection error -- surfaces it immediately", async () => {
			let connectCount = 0;
			let operationCalls = 0;
			const client = createRetryingClient(async () => {
				connectCount++;
				return new FakeClient(connectCount);
			});
			await expect(
				client.callOnce(async () => {
					operationCalls++;
					throw new TypeError("fetch failed");
				}),
			).rejects.toThrow("fetch failed");
			expect(operationCalls).toBe(1); // never re-run, unlike call()'s own retry-once behavior
		});

		it("drops the cached client on a stale-connection failure, so the NEXT callOnce()/call() reconnects", async () => {
			let connectCount = 0;
			const client = createRetryingClient(async () => {
				connectCount++;
				return new FakeClient(connectCount);
			});
			await expect(
				client.callOnce(async () => {
					throw new TypeError("fetch failed");
				}),
			).rejects.toThrow("fetch failed");
			expect(connectCount).toBe(1);

			// Self-heals here: the connection was dropped above, so this next call reconnects and succeeds.
			expect(await client.callOnce(async (c) => c.id)).toBe(2);
			expect(connectCount).toBe(2);
		});

		it("does NOT drop the cached client on a genuine domain-level rejection -- the connection itself was fine", async () => {
			let connectCount = 0;
			const client = createRetryingClient(async () => {
				connectCount++;
				return new FakeClient(connectCount);
			});
			await expect(
				client.callOnce(async () => {
					throw new Error("validation failed: missing field");
				}),
			).rejects.toThrow("validation failed");
			// Same cached client reused -- no reconnect for a non-stale error.
			expect(await client.callOnce(async (c) => c.id)).toBe(1);
			expect(connectCount).toBe(1);
		});

		it("respects the circuit breaker exactly like call() -- short-circuits without a new connect attempt once open", async () => {
			let connectCount = 0;
			const client = createRetryingClient<FakeClient>(
				async () => {
					connectCount++;
					throw new Error(`fail ${connectCount}`);
				},
				{ circuitBreaker: { failureThreshold: 2, cooldownMs: 10_000 } },
			);
			await expect(client.callOnce(async (c) => c.id)).rejects.toThrow("fail 1");
			await expect(client.callOnce(async (c) => c.id)).rejects.toThrow("fail 2");
			expect(client.breakerState().open).toBe(true);
			await expect(client.callOnce(async (c) => c.id)).rejects.toThrow("fail 2");
			expect(connectCount).toBe(2); // the third call short-circuited, no new connect attempt
		});
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

	it("forwards the provided env through to spawn, alongside the default auto-spawn launch provenance", () => {
		let capturedEnv: Record<string, string | undefined> | undefined;
		spawnDetachedDaemon({
			binPath: "/cli.ts",
			platform: "darwin",
			env: { FOO: "bar" },
			spawn: (_command, _args, options) => {
				capturedEnv = options.env;
			},
		});
		expect(capturedEnv).toEqual({ DAEMON_KIT_LAUNCH_PROVENANCE: "auto-spawn", FOO: "bar" });
	});

	it("lets a caller-supplied DAEMON_KIT_LAUNCH_PROVENANCE override the auto-spawn default", () => {
		let capturedEnv: Record<string, string | undefined> | undefined;
		spawnDetachedDaemon({
			binPath: "/cli.ts",
			platform: "linux",
			env: { DAEMON_KIT_LAUNCH_PROVENANCE: "service" },
			spawn: (_command, _args, options) => {
				capturedEnv = options.env;
			},
		});
		expect(capturedEnv?.DAEMON_KIT_LAUNCH_PROVENANCE).toBe("service");
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

describe("connectPushChannel", () => {
	let servers: ReturnType<typeof Bun.serve>[] = [];
	let clients: ReturnType<typeof connectPushChannel>[] = [];

	afterEach(() => {
		for (const client of clients) client.close();
		clients = [];
		for (const server of servers) server.stop(true);
		servers = [];
	});

	function startServer(token = "push-token"): { channel: PushChannel; url: string } {
		const channel = new PushChannel({ token });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, bunServer) => {
				if (new URL(request.url).pathname === "/push") return channel.upgrade(request, bunServer) ?? undefined;
				return new Response("not found", { status: 404 });
			},
			websocket: channel.websocketHandlers(),
		});
		servers.push(server);
		return { channel, url: `ws://127.0.0.1:${server.port}/push` };
	}

	function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		return new Promise((resolve, reject) => {
			const tick = (): void => {
				if (predicate()) {
					resolve();
					return;
				}
				if (Date.now() > deadline) {
					reject(new Error("waitFor timed out"));
					return;
				}
				setTimeout(tick, 5);
			};
			tick();
		});
	}

	it("connects, subscribes, and delivers a real publish() end to end", async () => {
		const { channel, url } = startServer();
		const received: Array<{ topic: string; payload: unknown }> = [];
		const client = connectPushChannel({
			url,
			token: "push-token",
			topics: ["tasks"],
			onMessage: (topic, payload) => received.push({ topic, payload }),
			minUptimeMs: 20,
		});
		clients.push(client);

		await waitFor(() => client.state() === "open");
		channel.publish("tasks", { mutated: "task-1" });
		await waitFor(() => received.length === 1);
		expect(received).toEqual([{ topic: "tasks", payload: { mutated: "task-1" } }]);
	});

	it("reconnects and re-subscribes after the daemon restarts on a brand new random port", async () => {
		const first = startServer();
		let currentUrl = first.url;
		const received: Array<{ topic: string; payload: unknown }> = [];
		const client = connectPushChannel({
			url: () => currentUrl,
			token: "push-token",
			topics: ["tasks"],
			onMessage: (topic, payload) => received.push({ topic, payload }),
			minUptimeMs: 20,
			minReconnectDelayMs: 10,
			maxReconnectDelayMs: 50,
		});
		clients.push(client);
		await waitFor(() => client.state() === "open");

		// Simulate a full daemon restart: the old server dies, a new one binds an
		// entirely different random port -- the same situation connectWithPolicy
		// handles for one-shot RPC by re-reading the handle file on each attempt.
		servers[0]!.stop(true);
		const second = startServer();
		currentUrl = second.url;

		// Confirm the drop is actually detected first -- otherwise the next
		// waitFor below could trivially "succeed" by observing the stale "open"
		// state left over from before the restart, never having actually waited
		// for a real reconnect at all.
		await waitFor(() => client.state() !== "open", 2_000);
		await waitFor(() => client.state() === "open", 5_000);
		second.channel.publish("tasks", { mutated: "after-restart" });
		await waitFor(() => received.length === 1, 2_000);
		expect(received).toEqual([{ topic: "tasks", payload: { mutated: "after-restart" } }]);
	});

	it("a connection that opens then drops before minUptimeMs keeps the backoff climbing instead of resetting on the next attempt (degradation)", async () => {
		class FakeWebSocket {
			static instances: FakeWebSocket[] = [];
			createdAt = Date.now();
			private readonly listeners: Record<string, Array<(event: unknown) => void>> = {};
			constructor(public url: string) {
				FakeWebSocket.instances.push(this);
			}
			addEventListener(type: string, handler: (event: unknown) => void): void {
				this.listeners[type] ??= [];
				this.listeners[type].push(handler);
			}
			send(): void {}
			close(): void {
				for (const handler of this.listeners.close ?? []) handler({});
			}
			simulateOpen(): void {
				for (const handler of this.listeners.open ?? []) handler({});
			}
		}

		const client = connectPushChannel({
			url: "ws://fake/push",
			token: "t",
			topics: [],
			onMessage: () => {},
			minUptimeMs: 10_000, // never reached in this test -- every open below counts as premature
			minReconnectDelayMs: 5,
			reconnectionDelayGrowFactor: 2,
			maxReconnectDelayMs: 1_000,
			WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
		});
		clients.push(client);

		await waitFor(() => FakeWebSocket.instances.length === 1);
		FakeWebSocket.instances[0]!.simulateOpen();
		FakeWebSocket.instances[0]!.close(); // drops immediately -- retryCount becomes 1

		await waitFor(() => FakeWebSocket.instances.length === 2, 1_000);
		FakeWebSocket.instances[1]!.simulateOpen();
		FakeWebSocket.instances[1]!.close(); // drops immediately again -- retryCount becomes 2, not reset to 0

		await waitFor(() => FakeWebSocket.instances.length === 3, 1_000);

		const firstDelay = FakeWebSocket.instances[1]!.createdAt - FakeWebSocket.instances[0]!.createdAt;
		const secondDelay = FakeWebSocket.instances[2]!.createdAt - FakeWebSocket.instances[1]!.createdAt;
		// growFactor 2 with a +/-20% jitter band: attempt 2's delay is ~4-6ms,
		// attempt 3's is ~8-12ms if (and only if) retryCount kept climbing rather
		// than resetting after the first open. The bands don't overlap, so this
		// is a real, non-flaky assertion of the degradation-gated backoff, not a
		// coincidence of timing.
		expect(secondDelay).toBeGreaterThan(firstDelay);
	});

	it("forces a reconnect via the heartbeat timeout when the socket stays open but stops responding entirely", async () => {
		class FakeWebSocket {
			static instances: FakeWebSocket[] = [];
			closeCalls = 0;
			private readonly listeners: Record<string, Array<(event: unknown) => void>> = {};
			constructor(public url: string) {
				FakeWebSocket.instances.push(this);
			}
			addEventListener(type: string, handler: (event: unknown) => void): void {
				this.listeners[type] ??= [];
				this.listeners[type].push(handler);
			}
			send(): void {
				// A completely unresponsive peer: never answers a ping with a pong,
				// never sends anything else either -- the socket itself never fires
				// close or error on its own, which is exactly the case a plain
				// reconnect-on-close strategy cannot detect.
			}
			close(): void {
				this.closeCalls++;
				for (const handler of this.listeners.close ?? []) handler({});
			}
			simulateOpen(): void {
				for (const handler of this.listeners.open ?? []) handler({});
			}
		}

		const client = connectPushChannel({
			url: "ws://fake/push",
			token: "t",
			topics: [],
			onMessage: () => {},
			minUptimeMs: 5,
			heartbeatIntervalMs: 5,
			heartbeatTimeoutMs: 20,
			minReconnectDelayMs: 5,
			WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
		});
		clients.push(client);

		await waitFor(() => FakeWebSocket.instances.length === 1);
		FakeWebSocket.instances[0]!.simulateOpen();

		// Never simulate any incoming message -- the heartbeat timeout must fire
		// close() on its own once heartbeatTimeoutMs elapses with nothing heard.
		await waitFor(() => FakeWebSocket.instances[0]!.closeCalls === 1, 1_000);
		await waitFor(() => FakeWebSocket.instances.length === 2, 1_000);
	});
});

describe("daemonStatus", () => {
	it("reports not-running when no handle exists", async () => {
		const status = await daemonStatus<DaemonHandleLike, FakeClient>({
			readHandle: () => null,
			buildClient: (handle) => new FakeClient(handle.port),
		});
		expect(status.state).toBe("not-running");
		expect(status.summary).toBe("not running");
	});

	it("reports stale-handle when the handle's pid is not actually alive", async () => {
		const status = await daemonStatus<DaemonHandleLike, FakeClient>({
			readHandle: () => FAKE_HANDLE,
			buildClient: (handle) => new FakeClient(handle.port),
			isPidAlive: () => false,
		});
		expect(status.state).toBe("stale-handle");
		expect(status.pid).toBe(FAKE_HANDLE.pid);
		expect(status.summary).toContain("stale handle");
	});

	it("reports running with version and uptime when the pid is alive and the client responds", async () => {
		const status = await daemonStatus<DaemonHandleLike, VersionedFakeClient>({
			readHandle: () => FAKE_HANDLE,
			buildClient: (handle) => ({ port: handle.port, version: "1.2.0" }),
			readVersion: async (c) => c.version,
			isPidAlive: () => true,
			startedAtMs: () => Date.now() - 5_000,
		});
		expect(status.state).toBe("running");
		expect(status.version).toBe("1.2.0");
		expect(status.uptimeMs).toBeGreaterThanOrEqual(5_000);
		expect(status.summary).toContain("v1.2.0");
	});

	it("reports unreachable when the pid is alive but the client/version read fails", async () => {
		const status = await daemonStatus<DaemonHandleLike, FakeClient>({
			readHandle: () => FAKE_HANDLE,
			buildClient: () => {
				throw new Error("connection refused");
			},
			isPidAlive: () => true,
		});
		expect(status.state).toBe("unreachable");
		expect(status.lastError).toBe("connection refused");
		expect(status.summary).toContain("not responding");
	});

	it("includes breaker state inline without needing a separate call", async () => {
		const status = await daemonStatus<DaemonHandleLike, FakeClient>({
			readHandle: () => null,
			buildClient: (handle) => new FakeClient(handle.port),
			breaker: () => ({ open: true, consecutiveFailures: 3, openedAt: 12345 }),
		});
		expect(status.breaker).toEqual({ open: true, consecutiveFailures: 3, openedAt: 12345 });
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
				killStaleProcess: () => {},
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

	it("still propagates a readVersion() failure once the bounded connect retry is exhausted -- an inconclusive read never triggers a kill", async () => {
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
					// attempts:1 keeps this deterministic and fast -- the retry itself is covered by
					// its own test below.
					connectRetry: { attempts: 1 },
				},
			),
		).rejects.toThrow("health endpoint unreachable");
		expect(killCalls).toBe(0);
	});

	it("retries the connect+readVersion round trip and succeeds once a transient failure clears -- closes the TOCTOU race where a concurrent caller kills the same stale daemon first", async () => {
		let readVersionCalls = 0;
		const client = await connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
			{
				readHandle: () => FAKE_HANDLE,
				buildClient: (handle) => ({ port: handle.port, version: "1.2.0" }),
				autoStart: true,
				spawn: () => {},
				fallbackMessage: "unreachable",
			},
			{
				expectedVersion: "1.2.0",
				readVersion: async (client) => {
					readVersionCalls++;
					if (readVersionCalls < 3) throw new Error("connection refused -- daemon mid-replacement");
					return client.version;
				},
				killStaleProcess: () => {},
				connectRetry: { attempts: 5, initialDelayMs: 1, maxDelayMs: 5 },
			},
		);
		expect(client.version).toBe("1.2.0");
		expect(readVersionCalls).toBe(3);
	});

	it("resolves a function expectedVersion fresh on every call instead of a cached string, matching -- no kill when the live value now matches", async () => {
		let spawnCalls = 0;
		let liveVersion = "1.2.0"; // simulates readPackageVersion() reflecting an on-disk update between calls
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
				expectedVersion: () => liveVersion,
				readVersion: async (c) => c.version,
				killStaleProcess: () => {},
			},
		);
		expect(client.port).toBe(4242);
		expect(spawnCalls).toBe(0);
		// The supplier is genuinely re-invoked, not cached from the first call -- a subsequent
		// change to what it returns is picked up on the very next connect.
		liveVersion = "9.9.9";
		await expect(
			connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
				{
					readHandle: () => FAKE_HANDLE,
					buildClient: (handle) => ({ port: handle.port, version: "1.2.0" }),
					fallbackMessage: "unreachable",
				},
				{
					expectedVersion: () => liveVersion,
					readVersion: async (c) => c.version,
					killStaleProcess: () => {},
				},
			),
		).rejects.toThrow(/expected 9\.9\.9/);
	});

	it("resolves an async function expectedVersion, awaiting it before comparing", async () => {
		const client = await connectWithVersionCheck<DaemonHandleLike, VersionedFakeClient>(
			{
				readHandle: () => FAKE_HANDLE,
				buildClient: (handle) => ({ port: handle.port, version: "1.2.0" }),
				fallbackMessage: "unreachable",
			},
			{
				expectedVersion: async () => "1.2.0",
				readVersion: async (c) => c.version,
				killStaleProcess: () => {},
			},
		);
		expect(client.port).toBe(4242);
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
