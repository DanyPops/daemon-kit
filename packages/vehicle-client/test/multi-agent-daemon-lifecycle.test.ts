/**
 * Reproduces the production shape directly: several separate "Pi agent" processes (a Pi
 * extension's own client.ts, a background overlay poller, an unrelated concurrent session) each
 * independently calling connectWithVersionCheck against ONE shared, already-running Vehicle
 * daemon -- not one process making N calls. Every agent is a real, separately-spawned process
 * with no shared memory, matching how a real daemon directory is actually contended in
 * production. The daemon's own PID (read from its real handle file, not guessed) is the ground
 * truth for whether a respawn happened.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VEHICLE_SERVER_ROOT = resolve(import.meta.dir, "..", "..", "vehicle-server", "src");
const VEHICLE_CLIENT_ROOT = resolve(import.meta.dir, "..", "src");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000, intervalMs = 20): Promise<void> {
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
			setTimeout(tick, intervalMs);
		};
		tick();
	});
}

function readHandlePid(handlePath: string): number | undefined {
	try {
		return (JSON.parse(readFileSync(handlePath, "utf8")) as { pid: number }).pid;
	} catch {
		return undefined;
	}
}

function runScript(scriptPath: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath.includes("bun") ? process.execPath : "bun", [scriptPath], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("exit", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
	});
}

/** A real, separately-owned HTTP daemon: /health reports a controllable version, /shutdown exits gracefully, SIGTERM exits directly. Every request is appended to LOG_PATH with a timestamp, so respawns are visible as a second DAEMON_START line, not inferred. */
function writeDaemonScript(path: string): void {
	writeFileSync(
		path,
		`
		import { appendFileSync } from "node:fs";
		import { startDaemon } from ${JSON.stringify(join(VEHICLE_SERVER_ROOT, "daemon.ts"))};

		const log = (line) => appendFileSync(process.env.LOG_PATH, \`\${Date.now()} pid=\${process.pid} \${line}\\n\`);

		const daemon = await startDaemon({
			daemonLabel: "TestDaemon",
			handlePath: process.env.HANDLE_PATH,
			buildApp: () => ({
				async fetch(request) {
					const url = new URL(request.url);
					log(\`request \${url.pathname}\`);
					if (url.pathname === "/health") {
						return Response.json({ ok: true, version: process.env.DAEMON_VERSION });
					}
					if (url.pathname === "/shutdown" && request.method === "POST") {
						log("graceful-shutdown-requested");
						setTimeout(async () => {
							await daemon.stop();
							process.exit(0);
						}, 5);
						return new Response("ok");
					}
					return new Response("not found", { status: 404 });
				},
			}),
		});

		log(\`DAEMON_START port=\${daemon.port} version=\${process.env.DAEMON_VERSION}\`);
		process.on("SIGTERM", () => {
			log("sigterm-received");
			process.exit(0);
		});
		`,
	);
}

/** A real, separate "Pi agent" process: connects via connectWithVersionCheck against the shared handle file, using this repo's real (already-fixed) daemon-client.ts source -- never a stale/duplicated copy. */
function writeAgentScript(path: string): void {
	writeFileSync(
		path,
		`
		import { appendFileSync, readFileSync } from "node:fs";
		import { connectWithVersionCheck } from ${JSON.stringify(join(VEHICLE_CLIENT_ROOT, "daemon-client.ts"))};

		const log = (line) => appendFileSync(process.env.RESULTS_PATH, \`\${process.env.AGENT_ID} \${line}\\n\`);

		function readHandle() {
			try {
				return JSON.parse(readFileSync(process.env.HANDLE_PATH, "utf8"));
			} catch {
				return null;
			}
		}

		const expectedVersion =
			process.env.EXPECTED_VERSION_MODE === "function"
				? () => readFileSync(process.env.VERSION_FILE_PATH, "utf8").trim()
				: process.env.EXPECTED_VERSION;

		try {
			const client = await connectWithVersionCheck(
				{
					readHandle,
					buildClient: (handle) => ({ baseUrl: \`http://127.0.0.1:\${handle.port}\`, pid: handle.pid }),
					autoStart: false,
					fallbackMessage: "no daemon running",
				},
				{
					expectedVersion,
					readVersion: async (client) => {
						const response = await fetch(\`\${client.baseUrl}/health\`);
						return (await response.json()).version;
					},
					killStaleProcess: (handle) => {
						try {
							process.kill(handle.pid, "SIGTERM");
						} catch {
							// already dead
						}
					},
					shutdownTimeoutMs: 1000,
					shutdownPollIntervalMs: 20,
				},
			);
			log(\`connected baseUrl=\${client.baseUrl}\`);
		} catch (error) {
			log(\`error \${error instanceof Error ? error.message : String(error)}\`);
		}
		`,
	);
}

describe("multi-agent daemon lifecycle: N faux Pi agents, N vehicle clients, one real vehicle-server daemon", () => {
	let dir: string | undefined;
	let daemonProc: ReturnType<typeof spawn> | undefined;

	afterEach(() => {
		if (daemonProc && !daemonProc.killed) daemonProc.kill("SIGKILL");
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		daemonProc = undefined;
	});

	async function startRealDaemon(version: string): Promise<{ handlePath: string; logPath: string }> {
		dir = mkdtempSync(join(tmpdir(), "vehicle-multi-agent-"));
		const daemonScriptPath = join(dir, "daemon.mjs");
		const handlePath = join(dir, "handle.json");
		const logPath = join(dir, "daemon.log");
		writeDaemonScript(daemonScriptPath);
		daemonProc = spawn("bun", [daemonScriptPath], {
			env: { ...process.env, HANDLE_PATH: handlePath, LOG_PATH: logPath, DAEMON_VERSION: version },
			stdio: "ignore",
		});
		await waitFor(() => readHandlePid(handlePath) !== undefined, 5_000);
		return { handlePath, logPath };
	}

	it("N agents that all agree on the real version never cause the daemon to respawn (plain-string expectedVersion)", async () => {
		const { handlePath, logPath } = await startRealDaemon("9.9.9");
		const initialPid = readHandlePid(handlePath);
		expect(initialPid).toBeDefined();

		dir ??= mkdtempSync(join(tmpdir(), "vehicle-multi-agent-fallback-"));
		const agentScriptPath = join(dir, "agent.mjs");
		const resultsPath = join(dir, "results.log");
		writeFileSync(resultsPath, "");
		writeAgentScript(agentScriptPath);

		const agentCount = 8;
		const results = await Promise.all(
			Array.from({ length: agentCount }, (_, i) =>
				runScript(agentScriptPath, {
					AGENT_ID: `agent-${i}`,
					HANDLE_PATH: handlePath,
					RESULTS_PATH: resultsPath,
					EXPECTED_VERSION: "9.9.9",
					EXPECTED_VERSION_MODE: "string",
					VERSION_FILE_PATH: "",
				}),
			),
		);
		for (const result of results) expect(result.code).toBe(0);

		await sleep(100); // let any in-flight respawn (there should be none) settle
		const finalPid = readHandlePid(handlePath);
		const daemonLog = readFileSync(logPath, "utf8");
		const startCount = daemonLog.split("\n").filter((line) => line.includes("DAEMON_START")).length;

		expect(finalPid).toBe(initialPid);
		expect(startCount).toBe(1); // exactly the original boot -- zero respawns

		const resultsLog = readFileSync(resultsPath, "utf8");
		for (let i = 0; i < agentCount; i++) expect(resultsLog).toContain(`agent-${i} connected`);
	}, 15_000);

	it("N agents using a lazy function expectedVersion (re-read fresh per call) also never cause a respawn", async () => {
		const { handlePath, logPath } = await startRealDaemon("9.9.9");
		const initialPid = readHandlePid(handlePath);

		dir ??= mkdtempSync(join(tmpdir(), "vehicle-multi-agent-fallback-"));
		const agentScriptPath = join(dir, "agent.mjs");
		const resultsPath = join(dir, "results.log");
		const versionFilePath = join(dir, "current-version.txt");
		writeFileSync(resultsPath, "");
		writeFileSync(versionFilePath, "9.9.9");
		writeAgentScript(agentScriptPath);

		const agentCount = 8;
		const results = await Promise.all(
			Array.from({ length: agentCount }, (_, i) =>
				runScript(agentScriptPath, {
					AGENT_ID: `agent-${i}`,
					HANDLE_PATH: handlePath,
					RESULTS_PATH: resultsPath,
					EXPECTED_VERSION: "",
					EXPECTED_VERSION_MODE: "function",
					VERSION_FILE_PATH: versionFilePath,
				}),
			),
		);
		for (const result of results) expect(result.code).toBe(0);

		await sleep(100);
		const finalPid = readHandlePid(handlePath);
		const daemonLog = readFileSync(logPath, "utf8");
		const startCount = daemonLog.split("\n").filter((line) => line.includes("DAEMON_START")).length;

		expect(finalPid).toBe(initialPid);
		expect(startCount).toBe(1);
	}, 15_000);

	it("a genuinely stale daemon (real version mismatch) is killed exactly once and every agent converges on the single replacement -- no respawn storm", async () => {
		const { handlePath, logPath } = await startRealDaemon("1.0.0"); // stale on purpose
		const stalePid = readHandlePid(handlePath);

		dir ??= mkdtempSync(join(tmpdir(), "vehicle-multi-agent-fallback-"));
		const agentScriptPath = join(dir, "agent.mjs");
		const resultsPath = join(dir, "results.log");
		writeFileSync(resultsPath, "");
		writeAgentScript(agentScriptPath);

		// No spawn() configured (autoStart:false in the agent script) -- a version mismatch with
		// nothing able to replace the daemon must surface a clear error, never kill-and-strand.
		const agentCount = 5;
		const results = await Promise.all(
			Array.from({ length: agentCount }, (_, i) =>
				runScript(agentScriptPath, {
					AGENT_ID: `agent-${i}`,
					HANDLE_PATH: handlePath,
					RESULTS_PATH: resultsPath,
					EXPECTED_VERSION: "2.0.0",
					EXPECTED_VERSION_MODE: "string",
					VERSION_FILE_PATH: "",
				}),
			),
		);
		for (const result of results) expect(result.code).toBe(0);

		const resultsLog = readFileSync(resultsPath, "utf8");
		// Every agent must report the same actionable error, never a raw connection failure.
		for (let i = 0; i < agentCount; i++) {
			expect(resultsLog).toContain(`agent-${i} error stale daemon detected`);
		}

		const daemonLog = readFileSync(logPath, "utf8");
		expect(daemonLog.split("\n").filter((line) => line.includes("DAEMON_START")).length).toBe(1);
		expect(readHandlePid(handlePath)).toBe(stalePid); // never killed -- no spawn() means no kill either
	}, 15_000);
});
