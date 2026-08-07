/**
 * Reproduces the production daemon-churn shape: N real "faux Pi agent" OS processes running
 * the real client chain (connectWithVersionCheck, registerVehicleTools) against one real
 * Vehicle daemon. Genuinely separate processes, not an in-process Promise.all -- the race
 * under test can't manifest with shared memory.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
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

/** OS processes matching the daemon script, via /proc (Linux-only). Over-counts on its own: a
 * process that loses the lock race still shows up for the few ms before it exits -- wasteful,
 * not a correctness bug. See listeningPortsForPid for the check that actually matters. */
function findDaemonScriptPids(scriptPath: string): number[] {
	const pids: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(scriptPath)) pids.push(Number(entry));
		} catch {
			// process exited between readdir and read -- not a real match
		}
	}
	return pids;
}

/** Ports a pid genuinely has bound and LISTENing, via its open socket fds
 * (/proc/<pid>/fd/*, `socket:[inode]`) cross-referenced against /proc/net/tcp's inode column
 * (st==0A). Unlike process existence, a lock-race loser never appears here. */
function listeningPortsForPid(pid: number): number[] {
	let socketInodes: Set<string>;
	try {
		socketInodes = new Set();
		for (const fd of readdirSync(`/proc/${pid}/fd`)) {
			try {
				const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
				if (match?.[1]) socketInodes.add(match[1]);
			} catch {
				// fd closed between readdir and readlink -- not a real socket
			}
		}
	} catch {
		return []; // process exited
	}
	if (socketInodes.size === 0) return [];

	const ports: number[] = [];
	let tcpTable: string;
	try {
		tcpTable = readFileSync("/proc/net/tcp", "utf8");
	} catch {
		return [];
	}
	for (const line of tcpTable.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		const localAddress = fields[1];
		const state = fields[3];
		const inode = fields[9];
		if (state !== "0A" || inode === undefined || !socketInodes.has(inode)) continue; // 0A == TCP_LISTEN
		const portHex = localAddress?.split(":")[1];
		if (portHex) ports.push(Number.parseInt(portHex, 16));
	}
	return ports;
}

interface ConcurrencySample {
	/** OS processes matching the daemon script -- informative only (wasted spin-up has a real
	 * cost), never proof of a correctness bug on its own. */
	maxLiveProcesses: number;
	/** Bound, listening daemon processes coexisting at the same instant -- the real question: a
	 * client could reach any of these, so more than one means requests can land on an orphan. */
	maxBoundListeners: number;
}

/** Samples on an interval until stop() is called, tracking the max concurrent counts seen --
 * the only way to catch a race that self-resolves before any single check would see it. */
function sampleDaemonConcurrency(scriptPath: string, intervalMs = 5): { stop: () => ConcurrencySample } {
	const sample = (): ConcurrencySample => {
		const pids = findDaemonScriptPids(scriptPath);
		const bound = pids.filter((pid) => listeningPortsForPid(pid).length > 0).length;
		return { maxLiveProcesses: pids.length, maxBoundListeners: bound };
	};
	let result = sample();
	const timer = setInterval(() => {
		const next = sample();
		result = {
			maxLiveProcesses: Math.max(result.maxLiveProcesses, next.maxLiveProcesses),
			maxBoundListeners: Math.max(result.maxBoundListeners, next.maxBoundListeners),
		};
	}, intervalMs);
	return {
		stop: () => {
			clearInterval(timer);
			return result;
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

// N faux Pi agents, each doing a real vehicle-client-pi registration, against one real Vehicle daemon.
describe("multi-agent daemon singleton", () => {
	let dir: string | undefined;
	let daemon: ManagedProcess | undefined;
	let daemonEvents: { lines: DaemonEvent[]; stop: () => void } | undefined;

	afterEach(async () => {
		daemonEvents?.stop();
		await daemon?.dispose();
		// A replacement daemon (spawned detached from inside an agent) isn't tracked by `daemon`
		// above and would otherwise leak. Killing only the handle file's current pid isn't enough
		// -- it's exactly the value under test for a race, so a real run can leave the handle
		// pointing at one pid while a different one is still genuinely bound. Sweep every process
		// still matching the daemon script instead, however it got there.
		for (const pid of findDaemonScriptPids(DAEMON_SCRIPT_PATH)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already dead
			}
		}
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		daemon = undefined;
		daemonEvents = undefined;
	});

	async function startRealDaemon(version: string, handlePath: string): Promise<void> {
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

	// The daemon starts exactly once across all 8.
	it("8 concurrent agents agreeing on the real version all register successfully", async () => {
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

	// The stale daemon is killed exactly once; every agent converges on the single replacement.
	it("a genuine version mismatch across all agents triggers exactly one daemon replacement", async () => {
		dir = mkdtempSync(join(tmpdir(), "vehicle-multi-agent-"));
		const handlePath = join(dir, "handle.json");
		await startRealDaemon("1.0.0", handlePath); // deliberately stale
		const stalePid = readHandle(handlePath)?.pid;

		const agentCount = 5;
		const sampler = sampleDaemonConcurrency(DAEMON_SCRIPT_PATH);
		const results = await Promise.all(Array.from({ length: agentCount }, (_, i) => runAgent(`agent-${i}`, handlePath, "2.0.0")));
		const concurrency = sampler.stop();

		for (const result of results) {
			expect(result.ok).toBe(true);
			expect(result.operationNames).toContain("ping.check");
		}

		// Racing OS processes that lose the lock are wasteful but harmless -- informative only.
		if (concurrency.maxLiveProcesses > 1) {
			console.info(`${concurrency.maxLiveProcesses} daemon-script processes coexisted (expected under a lock race; not itself a bug)`);
		}

		// The real regression: two racing processes both bound and listened at the same instant --
		// a client could land on either, and only one is the daemon anyone intends to be running.
		expect(concurrency.maxBoundListeners).toBe(1);

		// The daemon this test spawned directly started and was killed exactly once.
		const originalEvents = daemonEvents?.lines ?? [];
		expect(originalEvents.filter((line) => line.event === "daemon-start")).toHaveLength(1);
		expect(originalEvents.filter((line) => line.event === "daemon-stop")).toHaveLength(1);

		// The replacement is detached (stdio:"ignore", matching real auto-spawn) with no
		// observable stdout -- verified via a real network round trip instead.
		const finalHandle = readHandle(handlePath);
		expect(finalHandle?.pid).not.toBe(stalePid);

		const replacementClient = new RemoteVehicleClient({ baseUrl: `http://127.0.0.1:${finalHandle?.port}`, token: TOKEN });
		const replacementManifest = await replacementClient.manifest();
		expect(replacementManifest.version).toBe("2.0.0");
	}, 20_000);
});
