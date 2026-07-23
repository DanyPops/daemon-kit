import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon.ts";
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
