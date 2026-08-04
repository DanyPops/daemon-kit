/**
 * Real "faux Pi agent" subprocess: runs the same client chain a real Pi extension's
 * session_start does (connectWithVersionCheck, then registerVehicleTools) as a genuinely
 * separate OS process -- an in-process Promise.all would share memory and miss the
 * cross-process race this exists to catch.
 *
 * Spawned via `bun run` by multi-agent-daemon-singleton.test.ts. Reports one NDJSON line.
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

// Every distinct handle this agent ever saw, and every pid it ever sent SIGTERM to -- reported
// alongside the result so a failure can be traced to which port/pid it targeted and killed.
const observedHandles: DaemonHandle[] = [];
const killTargets: DaemonHandle[] = [];

function readHandle(): DaemonHandle | null {
	try {
		const handle = JSON.parse(require("node:fs").readFileSync(handlePath, "utf8")) as DaemonHandle;
		const last = observedHandles[observedHandles.length - 1];
		if (!last || last.port !== handle.port || last.pid !== handle.pid) observedHandles.push(handle);
		return handle;
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
					// Spread process.env first (matches papyrus's real client.ts) -- without it
					// "bun" has no PATH to be found on.
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
				killTargets.push(handle);
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
	emit({
		ok: true,
		toolCount: registered.tools.length,
		operationNames: registered.tools.map((tool) => tool.operationName),
		observedHandles,
		killTargets,
		connectedTo: (client as unknown as { baseUrl?: string }).baseUrl,
	});
} catch (error) {
	emit({ ok: false, error: error instanceof Error ? error.message : String(error), observedHandles, killTargets });
}
