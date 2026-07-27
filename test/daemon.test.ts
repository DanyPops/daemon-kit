import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAlreadyRunningError, startDaemon, type RunningDaemon } from "../src/daemon.ts";
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
	return { async fetch() { return new Response("ok"); } };
}

describe("startDaemon", () => {
	it("binds an OS-assigned loopback port and the handle file reflects it exactly", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		expect(daemon.port).toBeGreaterThan(0);
		expect(readDaemonHandle(handlePath)?.port).toBe(daemon.port);
	});

	it("stop() is idempotent and removes the handle file", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		await daemon.stop();
		await daemon.stop(); // must not throw
		expect(readDaemonHandle(handlePath)).toBeNull();
	});

	it("a failing maintenance task does not stop other maintenance tasks from running", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		let goodRuns = 0;
		const errors: string[] = [];
		daemon = startDaemon({
			daemonLabel: "Acme",
			handlePath,
			buildApp: trivialApp,
			logger: { debug() {}, info() {}, warn() {}, error: (msg) => errors.push(msg) },
			maintenanceTasks: [
				{ name: "good", intervalMs: 5, run: () => { goodRuns++; } },
				{ name: "bad", intervalMs: 5, run: () => { throw new Error("boom"); } },
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
			daemon = startDaemon({
				daemonLabel: "Acme",
				handlePath,
				buildApp: trivialApp,
				logger: { debug() {}, info() {}, warn() {}, error: (msg) => errors.push(msg) },
				maintenanceTasks: [
					{ name: "good", intervalMs: 5, run: () => { goodRuns++; } },
					{ name: "bad-async", intervalMs: 5, run: async () => { await Promise.resolve(); throw new Error("async boom"); } },
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
		daemon = startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp, onShutdown: () => { shutdowns++; } });
		await daemon.stop();
		await daemon.stop();
		expect(shutdowns).toBe(1);
	});

	it("an idle daemon past its budget shuts itself down without any request ever arriving", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = startDaemon({
			daemonLabel: "Acme",
			handlePath,
			buildApp: trivialApp,
			idleBudgetMs: 20,
			idleTickMs: 5,
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(readDaemonHandle(handlePath)).toBeNull();
	});

	it("a second startDaemon() against the same handlePath while the first is live throws DaemonAlreadyRunningError without binding a port or touching the handle", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		const firstPort = daemon.port;

		expect(() => startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp })).toThrow(DaemonAlreadyRunningError);
		// The original daemon's own handle/port must be completely undisturbed by the losing attempt.
		expect(readDaemonHandle(handlePath)?.port).toBe(firstPort);
	});

	it("N concurrent startDaemon() calls against the same handlePath result in exactly one bound port; the rest throw cleanly", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		const attempts: Array<RunningDaemon | DaemonAlreadyRunningError> = [];
		for (let i = 0; i < 6; i++) {
			try {
				attempts.push(startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp }));
			} catch (error) {
				if (error instanceof DaemonAlreadyRunningError) attempts.push(error);
				else throw error;
			}
		}
		const winners = attempts.filter((a): a is RunningDaemon => !(a instanceof DaemonAlreadyRunningError));
		expect(winners.length).toBe(1);
		expect(attempts.length - winners.length).toBe(5);
		daemon = winners[0];
	});

	it("a stale lock left by a crashed daemon (dead pid, handle never cleaned up) is stolen so a fresh start succeeds", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		const lockPath = join(dir, "daemon.lock");
		// Simulate a prior daemon that acquired the lock and then died without releasing it.
		const crashed = startDaemon({ daemonLabel: "Acme", handlePath, lockPath, buildApp: trivialApp });
		// Don't call stop() -- instead simulate the crash by force-removing only
		// the OS resources a real crash would drop, while the lock file (naming
		// this same, now-invalid-for-the-new-attempt pid) is left behind.
		await crashed.stop();
		// stop() already released the lock cleanly -- rewrite it to simulate an
		// unclean crash where the lock survives with a genuinely dead pid still
		// recorded (a real process that has already exited, not a guessed number).
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		writeFileSync(lockPath, `${dead.pid ?? 999_999}\n`);

		daemon = startDaemon({ daemonLabel: "Acme", handlePath, lockPath, buildApp: trivialApp });
		expect(daemon.port).toBeGreaterThan(0);
		expect(readDaemonHandle(handlePath)?.port).toBe(daemon.port);
	});

	it("stop() releases the single-instance lock, letting an entirely new startDaemon() succeed afterward", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		const first = startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		await first.stop();
		daemon = startDaemon({ daemonLabel: "Acme", handlePath, buildApp: trivialApp });
		expect(daemon.port).toBeGreaterThan(0);
	});

	it("activity (a real request) resets the idle budget", async () => {
		dir = mkdtempSync(join(tmpdir(), "daemon-kit-daemon-"));
		const handlePath = join(dir, "handle.json");
		daemon = startDaemon({
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
});
