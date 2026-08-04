/**
 * Reproduces, TDD-style, the real-world bug: a Pi extension's session_start calls
 * registerVehicleTools() exactly once. If the daemon is transiently unreachable at that
 * exact moment -- e.g. mid-restart from a legitimate version-check kill/respawn, or a
 * package update swapping the extension's files out from under a live process -- the
 * manifest fetch throws, registerVehicleTools() propagates that rejection, and (in
 * pi-papyrus's real registerNotesVehicle()) the failure is swallowed silently with no
 * retry path: every Vehicle-projected tool is permanently missing for the rest of that
 * session, even though the daemon comes back up within a few hundred milliseconds.
 *
 * This suite drives a real RemoteVehicleClient against a real Bun.serve Vehicle HTTP
 * app (createVehicleHttpApp/VehicleRegistry -- the same production code path, not a
 * fake), stopped and restarted on the *same* port mid-registration, matching the
 * daemon-down-then-back-up race exactly. It is expected to be RED against today's
 * registerVehicleTools() (no handshake retry exists yet) and turn GREEN once a bounded
 * retry/backoff handshake is added.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { registerVehicleTools } from "../src/vehicle-pi.ts";

const LIMITS = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 } as const;
const TOKEN = "test-token";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const pingSchema = defineVehicleSchema<Record<string, never>>({
	jsonSchema: { type: "object", properties: {}, additionalProperties: false },
	safeParse: (value) => ({ success: true, value: value as Record<string, never> }),
});

const pingOperation = defineVehicleOperation({
	name: "ping.check",
	version: 1,
	description: "Trivial operation used only to prove registration happened.",
	input: pingSchema,
	output: pingSchema,
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

const pingBinding = bindVehicleOperation(pingOperation, () => async () => ({}));

function buildRegistry(): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "test-vehicle", version: "1.0.0", description: "Test Vehicle." });
	registry.register("test-owner", pingBinding);
	return registry;
}

/** Binds a real Vehicle HTTP app to a fixed port so it can be stopped and rebound on the exact same port later -- the shape of a real daemon restart, not a fresh random port. */
function serveOnPort(port: number): ReturnType<typeof Bun.serve> {
	const app = createVehicleHttpApp({ registry: buildRegistry(), token: TOKEN });
	return Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => app.fetch(request) });
}

function fakePi() {
	const harness = createExtensionHarness(() => {});
	return harness.api;
}

describe("registerVehicleTools handshake against a real, transiently-down Vehicle daemon", () => {
	let server: ReturnType<typeof Bun.serve> | undefined;

	afterEach(() => {
		server?.stop(true);
		server = undefined;
	});

	it("registers tools once a daemon that was down at call time comes back up on the same port shortly after (no /reload, no manual retry)", async () => {
		// Bind once just to claim a real free port, then immediately release it --
		// the daemon is unreachable at the exact moment registration is attempted,
		// exactly like a session_start racing a version-check kill/respawn.
		const claim = serveOnPort(0);
		const port = claim.port;
		if (port === undefined) throw new Error("Bun.serve() did not assign a port");
		claim.stop(true);

		const client = new RemoteVehicleClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN });
		const pi = fakePi();

		const registrationPromise = registerVehicleTools(pi, client);

		// Real, observed daemon cold-boot time is ~100-300ms (see papyrus's own
		// connect-client-auto-spawn.test.ts) -- restart well inside that window.
		await sleep(150);
		server = serveOnPort(port);

		const registered = await registrationPromise;
		expect(registered.tools.map((tool) => tool.operationName)).toContain("ping.check");
	});
});
