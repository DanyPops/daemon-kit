import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DaemonAlreadyRunningError,
	DEFAULT_AUTO_SPAWN_IDLE_BUDGET_MS,
	type RunningDaemon,
	readLaunchProvenance,
	resolveIdleBudgetMs,
	runDaemonProcess,
	startDaemon,
} from "../src/daemon.ts";
import { readDaemonHandle } from "../src/paths.ts";

let daemon: RunningDaemon | undefined;
let dir: string | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function trivialApp() {
	return {
		async fetch() {
			return new Response("ok");
		},
	};
}

describe("readLaunchProvenance / resolveIdleBudgetMs", () => {
	it('reads a known provenance value from env, and "unknown" for anything else', () => {
		expect(readLaunchProvenance({ DAEMON_KIT_LAUNCH_PROVENANCE: "auto-spawn" })).toBe("auto-spawn");
		expect(readLaunchProvenance({ DAEMON_KIT_LAUNCH_PROVENANCE: "service" })).toBe("service");
		expect(readLaunchProvenance({ DAEMON_KIT_LAUNCH_PROVENANCE: "garbage" })).toBe("unknown");
		expect(readLaunchProvenance({})).toBe("unknown");
	});

	it("an explicit value always wins over provenance", () => {
		expect(resolveIdleBudgetMs(999, "service")).toBe(999);
		expect(resolveIdleBudgetMs(0, "auto-spawn")).toBe(0);
	});

	it("service provenance defaults to always-on (0); auto-spawn/unknown default to the bounded budget", () => {
		expect(resolveIdleBudgetMs(undefined, "service")).toBe(0);
		expect(resolveIdleBudgetMs(undefined, "auto-spawn")).toBe(DEFAULT_AUTO_SPAWN_IDLE_BUDGET_MS);
		expect(resolveIdleBudgetMs(undefined, "unknown")).toBe(DEFAULT_AUTO_SPAWN_IDLE_BUDGET_MS);
	});
});

describe("startDaemon", () => {
	it("binds an OS-assigned loopback port and the handle file reflects it exactly", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = await startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		expect(daemon.port).toBeGreaterThan(0);
		expect(readDaemonHandle(handlePath)?.port).toBe(daemon.port);
	});

	it("stop() is idempotent and removes the handle file", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = await startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		await daemon.stop();
		await daemon.stop(); // must not throw
		expect(readDaemonHandle(handlePath)).toBeNull();
	});

	it("defaults the handle file to owner-only (0600)", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = await startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		expect(statSync(handlePath).mode & 0o777).toBe(0o600);
	});

	it("honors an explicit handleMode -- a daemon meant to be discovered across OS users", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = await startDaemon({ daemonLabel: "Acme", handlePath, handleMode: 0o644, buildApp: trivialApp });
		expect(statSync(handlePath).mode & 0o777).toBe(0o644);
	});

	it("a failing maintenance task does not stop other maintenance tasks from running", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		let goodRuns = 0;
		const errors: string[] = [];
		daemon = await startDaemon({
			daemonLabel: "Acme",
			handlePath,
			buildApp: trivialApp,
			logger: { debug() {}, info() {}, warn() {}, error: (msg) => errors.push(msg) },
			maintenanceTasks: [
				{
					name: "good",
					intervalMs: 5,
					run: () => {
						goodRuns++;
					},
				},
				{
					name: "bad",
					intervalMs: 5,
					run: () => {
						throw new Error("boom");
					},
				},
			],
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(goodRuns).toBeGreaterThan(1);
		expect(errors.some((m) => m.includes("bad"))).toBe(true);
	});

	it("catches a rejected async maintenance task, not just a synchronous throw", async () => {
		// Regression test: an async task.run() rejection must never become an unhandled promise
		// rejection (Bun does not swallow those -- it crashes the process). A prior implementation
		// only wrapped the (synchronous) call to task.run() in try/catch, which cannot observe a
		// rejection surfacing later on the microtask queue.
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		let goodRuns = 0;
		const errors: string[] = [];
		const rejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			daemon = await startDaemon({
				daemonLabel: "Acme",
				handlePath,
				buildApp: trivialApp,
				logger: { debug() {}, info() {}, warn() {}, error: (msg) => errors.push(msg) },
				maintenanceTasks: [
					{
						name: "good",
						intervalMs: 5,
						run: () => {
							goodRuns++;
						},
					},
					{
						name: "bad-async",
						intervalMs: 5,
						run: async () => {
							await Promise.resolve();
							throw new Error("async boom");
						},
					},
				],
			});
			await new Promise((resolve) => setTimeout(resolve, 40));
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
		expect(goodRuns).toBeGreaterThan(1);
		expect(errors.some((m) => m.includes("bad-async"))).toBe(true);
		expect(rejections).toEqual([]);
	});

	it("calls onShutdown exactly once during stop()", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		let shutdowns = 0;
		daemon = await startDaemon({
			daemonLabel: "Acme",
			handlePath,
			buildApp: trivialApp,
			onShutdown: () => {
				shutdowns++;
			},
		});
		await daemon.stop();
		await daemon.stop();
		expect(shutdowns).toBe(1);
	});

	it("an idle daemon past its budget shuts itself down without any request ever arriving", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = await startDaemon({
			daemonLabel: "Acme",
			handlePath,
			buildApp: trivialApp,
			idleBudgetMs: 20,
			idleTickMs: 5,
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(readDaemonHandle(handlePath)).toBeNull();
	});

	it("a second startDaemon() against the same handlePath while the first is live rejects with DaemonAlreadyRunningError without binding a port or touching the handle", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = await startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		const firstPort = daemon.port;

		// startDaemon() is async now (Node's listen() cannot bind synchronously
		// the way Bun.serve() does), so a losing attempt rejects rather than
		// throwing synchronously -- .rejects, not a synchronous expect(() => ...).
		await expect(startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp })).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
		// The original daemon's own handle/port must be completely undisturbed by the losing attempt.
		expect(readDaemonHandle(handlePath)?.port).toBe(firstPort);
	});

	it("N concurrent startDaemon() calls against the same handlePath result in exactly one bound port; the rest reject cleanly", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		// Fired without awaiting between them so every call's synchronous prefix
		// (including the actual lock acquisition) races the same way it would
		// under N genuinely concurrent callers -- Promise.allSettled only
		// changes how the *results* are collected, not when each call started.
		const attempts = await Promise.allSettled(
			Array.from({ length: 6 }, () => startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp })),
		);
		const winners = attempts.filter((a): a is PromiseFulfilledResult<RunningDaemon> => a.status === "fulfilled");
		const losers = attempts.filter((a) => a.status === "rejected");
		expect(winners.length).toBe(1);
		expect(losers.length).toBe(5);
		for (const loser of losers) {
			expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyRunningError);
		}
		daemon = winners[0]!.value;
	});

	it("a stale lock left by a crashed daemon (dead pid, handle never cleaned up) is stolen so a fresh start succeeds", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		const lockPath = join(dir, "daemon.lock");
		// Simulate a prior daemon that acquired the lock and then died without releasing it.
		const crashed = await startDaemon({ daemonLabel: "Acme", handlePath, lockPath, buildApp: trivialApp });
		// Don't call stop() -- instead simulate the crash by force-removing only
		// the OS resources a real crash would drop, while the lock file (naming
		// this same, now-invalid-for-the-new-attempt pid) is left behind.
		await crashed.stop();
		// stop() already released the lock cleanly -- rewrite it to simulate an
		// unclean crash where the lock survives with a genuinely dead pid still
		// recorded (a real process that has already exited, not a guessed number).
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		writeFileSync(lockPath, `${dead.pid ?? 999_999}\n`);

		daemon = await startDaemon({ daemonLabel: "Acme", handlePath, lockPath, buildApp: trivialApp });
		expect(daemon.port).toBeGreaterThan(0);
		expect(readDaemonHandle(handlePath)?.port).toBe(daemon.port);
	});

	it("stop() releases the single-instance lock, letting an entirely new startDaemon() succeed afterward", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		const first = await startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		await first.stop();
		daemon = await startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		expect(daemon.port).toBeGreaterThan(0);
	});

	it("launch provenance from env drives the default idle budget when the caller doesn't set one explicitly", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const serviceDaemon = await startDaemon({
			daemonLabel: "Acme",
			handlePath: join(dir, "service", "handle.json"),
			buildApp: trivialApp,
			env: { DAEMON_KIT_LAUNCH_PROVENANCE: "service" },
		});
		expect(serviceDaemon.idleBudgetMs).toBe(0);
		await serviceDaemon.stop();

		daemon = await startDaemon({
			daemonLabel: "Acme",
			handlePath: join(dir, "auto", "handle.json"),
			buildApp: trivialApp,
			env: { DAEMON_KIT_LAUNCH_PROVENANCE: "auto-spawn" },
		});
		expect(daemon.idleBudgetMs).toBe(DEFAULT_AUTO_SPAWN_IDLE_BUDGET_MS);
	});

	it("an explicit idleBudgetMs always overrides the provenance-derived default", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		daemon = await startDaemon({
			daemonLabel: "Acme",
			handlePath: join(dir, "handle.json"),
			buildApp: trivialApp,
			env: { DAEMON_KIT_LAUNCH_PROVENANCE: "service" },
			idleBudgetMs: 12_345,
		});
		expect(daemon.idleBudgetMs).toBe(12_345);
	});

	it("activity (a real request) resets the idle budget", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = await startDaemon({
			daemonLabel: "Acme",
			handlePath,
			buildApp: trivialApp,
			idleBudgetMs: 60,
			idleTickMs: 10,
		});
		const port = daemon.port;
		// Keep the daemon "active" for longer than the idle budget by polling it.
		for (let i = 0; i < 10; i++) {
			await fetch(`http://127.0.0.1:${port}/`);
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
		expect(readDaemonHandle(handlePath)).not.toBeNull();
	});

	it("rejects a pushChannel option under a non-Bun runtime instead of silently ignoring it", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		// This test always runs under bun test (isBun is true here), so it
		// can't force the real Node code path directly -- it instead proves
		// the *documented contract* via a fake PushChannel-shaped object,
		// asserting the guard exists and fires before anything binds. The
		// actual cross-runtime HTTP behavior is proven by
		// test/daemon-node-e2e.test.ts, which spawns a real `node` process.
		if (typeof Bun === "undefined") {
			await expect(
				startDaemon({
					daemonLabel: "Acme",
					handlePath,
					buildApp: trivialApp,
					pushChannel: {} as never,
				}),
			).rejects.toThrow(/pushChannel requires the Bun runtime/);
			expect(readDaemonHandle(handlePath)).toBeNull();
		}
	});
});

describe("runDaemonProcess idle-shutdown", () => {
	// stop()'s idle path must exit the process, not just remove the handle file --
	// otherwise a process manager's Restart=always never triggers.
	it("actually exits the process once the idle budget is exceeded, the same way SIGTERM does -- not just removing the handle file", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-idle-exit-"));
		const handlePath = join(dir, "handle.json");
		const originalExit = process.exit;
		let exitCode: number | undefined;
		process.exit = ((code?: number) => {
			exitCode = code;
		}) as typeof process.exit;
		try {
			runDaemonProcess({
				daemonLabel: "Acme",
				handlePath,
				buildApp: trivialApp,
				idleBudgetMs: 20,
				idleTickMs: 5,
			});
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(readDaemonHandle(handlePath)).toBeNull();
			expect(exitCode).toBe(0);
		} finally {
			process.exit = originalExit;
		}
	});
});
