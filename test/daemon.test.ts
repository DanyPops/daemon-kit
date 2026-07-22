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
