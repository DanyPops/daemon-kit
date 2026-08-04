/**
 * Real, standalone "faux Pi agent" subprocess: drives the exact same client chain a real Pi
 * extension's session_start does (connectWithVersionCheck, then registerVehicleTools against
 * the resulting client) as a genuinely separate OS process with its own PID, module cache, and
 * process-local state -- an in-process Promise.all of N calls would share all of that and could
 * never catch a cross-process race the real bug depends on.
 *
 * Spawned via `bun run` by test/multi-agent-daemon-singleton.test.ts. Reports exactly one
 * NDJSON result line on stdout; never writes to a shared file.
 */
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { connectWithVersionCheck, spawnDetachedDaemon } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { registerVehicleTools } from "../../src/vehicle-pi.ts";

interface DaemonHandle {
	host: string;
	port: number;
	pid: number;
}

const agentId = process.env.AGENT_ID;
const handlePath = process.env.HANDLE_PATH;
const token = process.env.DAEMON_TOKEN;
const expectedVersion = process.env.EXPECTED_VERSION;
const daemonScriptPath = process.env.DAEMON_SCRIPT_PATH;
if (!agentId || !handlePath || !token || !expectedVersion || !daemonScriptPath) {
	throw new Error("AGENT_ID, HANDLE_PATH, DAEMON_TOKEN, EXPECTED_VERSION, and DAEMON_SCRIPT_PATH are required");
}

function emit(result: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ agentId, ...result })}\n`);
}

function readHandle(): DaemonHandle | null {
	try {
		return JSON.parse(require("node:fs").readFileSync(handlePath, "utf8")) as DaemonHandle;
	} catch {
		return null;
	}
}

try {
	const client = await connectWithVersionCheck<DaemonHandle, RemoteVehicleClient>(
		{
			readHandle,
			buildClient: (handle) => new RemoteVehicleClient({ baseUrl: `http://${handle.host}:${handle.port}`, token }),
			autoStart: true,
			spawn: () =>
				spawnDetachedDaemon({
					binPath: "bun",
					args: ["run", daemonScriptPath],
					// Matches every real production caller (e.g. papyrus's client.ts): spread
					// process.env first -- an env object with no PATH means the spawned "bun"
					// can never even be found, an entirely different failure than what this
					// suite exists to catch.
					env: { ...process.env, HANDLE_PATH: handlePath, DAEMON_TOKEN: token, DAEMON_VERSION: expectedVersion },
					spawn: (command, args, options) => {
						require("node:child_process")
							.spawn(command, args, { ...options, stdio: "ignore" })
							.unref();
					},
				}),
			fallbackMessage: "no daemon reachable and autoStart failed",
		},
		{
			expectedVersion,
			readVersion: async (client) => (await client.manifest()).version,
			killStaleProcess: (handle) => {
				try {
					process.kill(handle.pid, "SIGTERM");
				} catch {
					// already dead
				}
			},
			shutdownTimeoutMs: 1_000,
			shutdownPollIntervalMs: 20,
		},
	);

	const pi = createExtensionHarness(() => {}).api;
	const registered = await registerVehicleTools(pi, client);
	emit({ ok: true, toolCount: registered.tools.length, operationNames: registered.tools.map((tool) => tool.operationName) });
} catch (error) {
	emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
