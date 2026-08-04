/**
 * Real, standalone Vehicle daemon subprocess for multi-agent daemon-lifecycle tests. Spawned
 * via `bun run` by test/multi-agent-daemon-singleton.test.ts, never imported directly -- it
 * needs to be a genuinely separate OS process so the daemon's own PID is real, observable
 * ground truth (an in-process Bun.serve daemon has no PID of its own to churn).
 *
 * Every lifecycle event (start, request, shutdown) is a single NDJSON line on stdout, read by
 * the parent test via pi-process-harness's ManagedProcess.onStdout -- no shared log file.
 */
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { runDaemonProcess } from "@danypops/vehicle-server/daemon";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";

const handlePath = process.env.HANDLE_PATH;
const token = process.env.DAEMON_TOKEN;
const version = process.env.DAEMON_VERSION;
if (!handlePath || !token || !version) throw new Error("HANDLE_PATH, DAEMON_TOKEN, and DAEMON_VERSION are required");

function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ pid: process.pid, ...event })}\n`);
}

const pingSchema = defineVehicleSchema<Record<string, never>>({
	jsonSchema: { type: "object", properties: {}, additionalProperties: false },
	safeParse: (value) => ({ success: true, value: value as Record<string, never> }),
});

const pingOperation = defineVehicleOperation({
	name: "ping.check",
	version: 1,
	description: "Trivial operation used only to prove a real registration round trip happened.",
	input: pingSchema,
	output: pingSchema,
	effect: "read",
	idempotency: { mode: "safe" },
	limits: { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 },
});

const registry = new VehicleRegistry({ name: "test-vehicle", version, description: "Multi-agent lifecycle test daemon." });
registry.register(
	"test-owner",
	bindVehicleOperation(pingOperation, () => async () => ({})),
);

const app = createVehicleHttpApp({ registry, token });

// runDaemonProcess (not startDaemon directly) -- it's the real production entry point that
// wires SIGINT/SIGTERM to a genuine graceful stop() (which clears the handle file) before
// exiting. A hand-rolled `process.on("SIGTERM", () => process.exit(0))` skips that handle-file
// cleanup entirely, which was confirmed live to make connectWithVersionCheck's post-kill poll
// loop see a handle that never clears and hand back a client pointed at the now-dead process.
runDaemonProcess({
	daemonLabel: "MultiAgentTestDaemon",
	handlePath,
	buildApp: () => ({
		fetch(request: Request) {
			emit({ event: "request", path: new URL(request.url).pathname });
			return app.fetch(request);
		},
	}),
	onListen: ({ port }) => emit({ event: "daemon-start", port, version }),
});

process.on("SIGTERM", () => emit({ event: "daemon-stop", reason: "SIGTERM" }));
