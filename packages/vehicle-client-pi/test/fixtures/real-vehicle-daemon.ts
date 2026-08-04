/**
 * Real Vehicle daemon subprocess for multi-agent-daemon-singleton.test.ts. Genuinely separate
 * OS process, spawned via `bun run` -- an in-process Bun.serve daemon has no PID of its own to
 * churn. Every lifecycle event is one NDJSON line on stdout.
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

// runDaemonProcess (not startDaemon) wires SIGTERM to a real stop() that clears the handle
// file. A hand-rolled exit handler skips that, leaving a handle connectWithVersionCheck's
// post-kill poll never sees clear -- confirmed live to hand back a client pointed at a dead pid.
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
