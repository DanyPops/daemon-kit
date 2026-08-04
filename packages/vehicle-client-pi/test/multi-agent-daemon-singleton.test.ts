/**
 * Real-process reproduction of the production daemon-churn shape: N separate "faux Pi agent"
 * OS processes, each independently running the exact client chain a real Pi extension's
 * session_start does (connectWithVersionCheck, then registerVehicleTools) against ONE real,
 * already-running Vehicle daemon subprocess. Every process here is genuinely separate --
 * spawned via @danypops/pi-process-harness, never an in-process Promise.all -- because the
 * bug class under test (two independent processes racing to spawn/kill a shared daemon) has no
 * way to manifest with shared memory or a shared module cache.
 *
 * The daemon's own PID (read from its real handle file and cross-checked against every
 * "daemon-start" NDJSON line on its stdout) is the ground truth: this suite asserts it starts
 * exactly once, regardless of how many agents connect concurrently.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ManagedProcess, spawnManagedProcess } from "@danypops/pi-process-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";

const READY_TIMEOUT_MS = 5_000;
const READY_POLL_INTERVAL_MS = 20;

async function waitUntilReady(predicate: () => boolean, timeoutMs: number, pollIntervalMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() >= deadline) throw new Error("timed out waiting for readiness");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
	}
}

const DAEMON_SCRIPT_PATH = resolve(import.meta.dir, "fixtures", "real-vehicle-daemon.ts");
const AGENT_SCRIPT_PATH = resolve(import.meta.dir, "fixtures", "faux-pi-agent.ts");
const TOKEN = "multi-agent-test-token";

interface DaemonHandle {
	host: string;
	port: number;
	pid: number;
}

interface DaemonEvent {
	pid: number;
	event: "daemon-start" | "daemon-stop" | "request";
	[key: string]: unknown;
}

interface AgentResult {
	agentId: string;
	ok: boolean;
	toolCount?: number;
	operationNames?: string[];
	error?: string;
}

function readHandle(handlePath: string): DaemonHandle | null {
	try {
		return JSON.parse(readFileSync(handlePath, "utf8")) as DaemonHandle;
	} catch {
		return null;
	}
}

/** Real ground truth for "how many daemon processes actually exist right now", independent of
 * any handle file or stdout log either of them might have raced to write -- reads /proc
 * directly (Linux-only, matching this test's own environment) rather than trusting
 * self-reported state from a process that might itself be mid-race. */
function countLiveDaemonProcesses(scriptPath: string): number {
	let count = 0;
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(scriptPath)) count++;
		} catch {
			// process exited between readdir and read -- not a real match
		}
	}
	return count;
}

/** Samples countLiveDaemonProcesses on an interval until `stop()` is called, tracking the
 * highest concurrent count observed -- the only way to catch a thundering-herd respawn race
 * that resolves itself (down to 1) before any single point-in-time check would see it. */
function sampleMaxConcurrentDaemons(scriptPath: string, intervalMs = 10): { stop: () => number } {
	let max = countLiveDaemonProcesses(scriptPath);
	const timer = setInterval(() => {
		max = Math.max(max, countLiveDaemonProcesses(scriptPath));
	}, intervalMs);
	return {
		stop: () => {
			clearInterval(timer);
			return max;
		},
	};
}

function collectNdjson<T>(process: { onStdout: (listener: (chunk: Buffer) => void) => () => void }): { lines: T[]; stop: () => void } {
	const lines: T[] = [];
	let buffer = "";
	const stop = process.onStdout((chunk) => {
		buffer += chunk.toString("utf8");
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			if (part.trim().length === 0) continue;
			lines.push(JSON.parse(part) as T);
		}
	});
	return { lines, stop };
}

describe("multi-agent daemon singleton: N faux Pi agents, N vehicle-client-pi registrations, one real Vehicle daemon", () => {
	let dir: string | undefined;
	let daemon: ManagedProcess | undefined;
	let daemonEvents: { lines: DaemonEvent[]; stop: () => void } | undefined;
	let handlePathForCleanup: string | undefined;

	afterEach(async () => {
		daemonEvents?.stop();
		await daemon?.dispose();
		// A version-mismatch test replaces the daemon via a real, detached spawnDetachedDaemon
		// call from inside an agent subprocess -- that replacement is never tracked by `daemon`
		// above, so it would otherwise leak past this test. Whatever PID the handle file names
		// at teardown time is killed directly; a no-op if it's already the (disposed) original.
		if (handlePathForCleanup) {
			const survivingPid = readHandle(handlePathForCleanup)?.pid;
			if (survivingPid !== undefined) {
				try {
					process.kill(survivingPid, "SIGKILL");
				} catch {
					// already dead
				}
			}
		}
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		daemon = undefined;
		daemonEvents = undefined;
		handlePathForCleanup = undefined;
	});

	async function startRealDaemon(version: string, handlePath: string): Promise<void> {
		handlePathForCleanup = handlePath;
		daemon = spawnManagedProcess({
			command: "bun",
			args: ["run", DAEMON_SCRIPT_PATH],
			env: { HANDLE_PATH: handlePath, DAEMON_TOKEN: TOKEN, DAEMON_VERSION: version },
		});
		daemonEvents = collectNdjson<DaemonEvent>(daemon);
		await waitUntilReady(() => readHandle(handlePath) !== null, READY_TIMEOUT_MS, READY_POLL_INTERVAL_MS);
	}

	async function runAgent(agentId: string, handlePath: string, expectedVersion: string): Promise<AgentResult> {
		const agent = spawnManagedProcess({
			command: "bun",
			args: ["run", AGENT_SCRIPT_PATH],
			env: {
				AGENT_ID: agentId,
				HANDLE_PATH: handlePath,
				DAEMON_TOKEN: TOKEN,
				EXPECTED_VERSION: expectedVersion,
				DAEMON_SCRIPT_PATH,
			},
		});
		const results = collectNdjson<AgentResult>(agent);
		await agent.waitForExit();
		results.stop();
		if (results.lines.length !== 1) {
			throw new Error(`agent ${agentId} produced ${results.lines.length} result lines (stderr: ${agent.stderr})`);
		}
		return results.lines[0] as AgentResult;
	}

	it("8 concurrent agents that all agree on the real version register successfully and the daemon starts exactly once", async () => {
		dir = mkdtempSync(join(tmpdir(), "vehicle-multi-agent-"));
		const handlePath = join(dir, "handle.json");
		await startRealDaemon("9.9.9", handlePath);
		const initialPid = readHandle(handlePath)?.pid;
		expect(initialPid).toBeDefined();

		const agentCount = 8;
		const results = await Promise.all(Array.from({ length: agentCount }, (_, i) => runAgent(`agent-${i}`, handlePath, "9.9.9")));

		for (const result of results) {
			expect(result.ok).toBe(true);
			expect(result.operationNames).toContain("ping.check");
		}

		const finalPid = readHandle(handlePath)?.pid;
		const startEvents = daemonEvents?.lines.filter((line) => line.event === "daemon-start") ?? [];
		expect(startEvents).toHaveLength(1);
		expect(finalPid).toBe(initialPid);
		expect(daemon?.pid).toBe(initialPid);
	}, 20_000);

	it("a genuine version mismatch across all agents kills the stale daemon exactly once and every agent converges on the single replacement", async () => {
		dir = mkdtempSync(join(tmpdir(), "vehicle-multi-agent-"));
		const handlePath = join(dir, "handle.json");
		await startRealDaemon("1.0.0", handlePath); // deliberately stale
		const stalePid = readHandle(handlePath)?.pid;

		const agentCount = 5;
		const sampler = sampleMaxConcurrentDaemons(DAEMON_SCRIPT_PATH);
		const results = await Promise.all(Array.from({ length: agentCount }, (_, i) => runAgent(`agent-${i}`, handlePath, "2.0.0")));
		const maxConcurrentDaemons = sampler.stop();

		for (const result of results) {
			expect(result.ok).toBe(true);
			expect(result.operationNames).toContain("ping.check");
		}

		// The real regression this test exists to catch: connectWithPolicy's autoStart path has
		// no cross-process mutual exclusion, so N agents independently observing the same missing
		// handle file during the kill/respawn window can each call spawn() -- a thundering herd of
		// replacement daemons, not the single one every agent should converge on.
		expect(maxConcurrentDaemons).toBe(1);

		// The original daemon this test spawned directly (visible stdout) started and was
		// killed exactly once -- never restarted itself, never asked to start a second time.
		const originalEvents = daemonEvents?.lines ?? [];
		expect(originalEvents.filter((line) => line.event === "daemon-start")).toHaveLength(1);
		expect(originalEvents.filter((line) => line.event === "daemon-stop")).toHaveLength(1);

		// The replacement is spawned detached (stdio:"ignore", matching real production auto-spawn)
		// so it has no observable stdout -- verified via a real network round trip instead, exactly
		// how a real caller would confirm it, not process introspection.
		const finalHandle = readHandle(handlePath);
		expect(finalHandle?.pid).not.toBe(stalePid);

		const replacementClient = new RemoteVehicleClient({ baseUrl: `http://127.0.0.1:${finalHandle?.port}`, token: TOKEN });
		const replacementManifest = await replacementClient.manifest();
		expect(replacementManifest.version).toBe("2.0.0");
	}, 20_000);
});
