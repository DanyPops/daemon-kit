/**
 * Reproduces a real incident: two installed copies of the same consumer package (different
 * versions, neither wrong) both point at one shared daemon handle file. Each resolves its own
 * `expectedVersion` from its own package.json, so they disagree about which daemon version is
 * correct -- and each has autoStart+spawn. connectWithVersionCheck's existing coverage
 * (multi-agent-daemon-lifecycle.test.ts) only handles agents that agree on one version, or a
 * stale daemon nothing can replace. It has no case for two agents that individually disagree
 * and can both spawn a replacement -- that's the gap this test adds.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VEHICLE_SERVER_ROOT = resolve(import.meta.dir, "..", "..", "vehicle-server", "src");
const VEHICLE_CLIENT_ROOT = resolve(import.meta.dir, "..", "src");

function waitFor(predicate: () => boolean, timeoutMs = 5_000, intervalMs = 20): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolvePromise, reject) => {
		const tick = (): void => {
			if (predicate()) {
				resolvePromise();
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

/** Same real vehicle-server daemon shape as multi-agent-daemon-lifecycle.test.ts's fixture -- version is env-controlled, /health reports it, /shutdown exits gracefully, SIGTERM exits directly. */
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

		log(\`DAEMON_START version=\${process.env.DAEMON_VERSION}\`);
		process.on("SIGTERM", () => {
			log("sigterm-received");
			process.exit(0);
		});
		`,
	);
}

/**
 * A real, separate "installed copy" agent process: connects via connectWithVersionCheck with
 * autoStart:true and a real spawn() that starts ANOTHER copy of the exact same daemon script,
 * but reporting THIS agent's own expected version -- mirroring how each of two divergent
 * installed package copies would spawn a daemon that runs its own bundled source.
 */
function writeAgentScript(daemonScriptPath: string): string {
	const path = join(tmpdir(), `vehicle-flap-agent-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(
		path,
		`
		import { spawn } from "node:child_process";
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

		try {
			const client = await connectWithVersionCheck(
				{
					readHandle,
					buildClient: (handle) => ({ baseUrl: \`http://127.0.0.1:\${handle.port}\`, pid: handle.pid }),
					autoStart: true,
					spawn: () => {
						const child = spawn("bun", [${JSON.stringify(daemonScriptPath)}], {
							env: { ...process.env, DAEMON_VERSION: process.env.EXPECTED_VERSION },
							detached: true,
							stdio: "ignore",
						});
						child.unref();
					},
					fallbackMessage: "no daemon running",
				},
				{
					expectedVersion: process.env.EXPECTED_VERSION,
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
					shutdownTimeoutMs: 1500,
					shutdownPollIntervalMs: 20,
				},
			);
			log(\`connected version=\${process.env.EXPECTED_VERSION} baseUrl=\${client.baseUrl}\`);
		} catch (error) {
			log(\`error \${error instanceof Error ? error.message : String(error)}\`);
		}
		`,
	);
	return path;
}

describe("fix: two installed copies with different expectedVersions converge instead of flapping", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("alternating reconnects from a newer-expecting agent and an older-expecting agent converge on the newer version, with the older agent refusing instead of downgrading the daemon", async () => {
		dir = mkdtempSync(join(tmpdir(), "vehicle-flap-"));
		const handlePath = join(dir, "handle.json");
		const logPath = join(dir, "daemon.log");
		const resultsPath = join(dir, "results.log");
		writeFileSync(resultsPath, "");
		const daemonScriptPath = join(dir, "daemon.mjs");
		writeDaemonScript(daemonScriptPath);
		const agentScriptPath = writeAgentScript(daemonScriptPath);

		// Agent A (0.45.0) and Agent B (0.44.12) reconnecting in alternation, unsynchronized --
		// matching independent reconnect sources (a poll timer, a push-channel reconnect, a retry).
		const rounds = 4;
		for (let round = 0; round < rounds; round++) {
			const agentA = await runScript(agentScriptPath, {
				AGENT_ID: `A-round${round}`,
				HANDLE_PATH: handlePath,
				RESULTS_PATH: resultsPath,
				LOG_PATH: logPath,
				EXPECTED_VERSION: "0.45.0",
			});
			expect(agentA.code).toBe(0);
			await waitFor(() => readHandlePid(handlePath) !== undefined, 3_000);

			const agentB = await runScript(agentScriptPath, {
				AGENT_ID: `B-round${round}`,
				HANDLE_PATH: handlePath,
				RESULTS_PATH: resultsPath,
				LOG_PATH: logPath,
				EXPECTED_VERSION: "0.44.12",
			});
			expect(agentB.code).toBe(0);
			await waitFor(() => readHandlePid(handlePath) !== undefined, 3_000);
		}

		const daemonLog = readFileSync(logPath, "utf8");
		const startCount = daemonLog.split("\n").filter((line) => line.includes("DAEMON_START")).length;
		const resultsLog = readFileSync(resultsPath, "utf8");

		// Exactly one spawn ever -- agent A's first connect. Agent B never gets to kill or
		// replace it, on any round: the daemon stays on the newer version for good.
		expect(startCount).toBe(1);

		for (let round = 0; round < rounds; round++) {
			expect(resultsLog).toContain(`A-round${round} connected version=0.45.0`);
			expect(resultsLog).toContain(`B-round${round} error daemon is running a newer version (0.45.0) than this client expects (0.44.12)`);
		}
	}, 30_000);
});
