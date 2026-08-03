import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createVehicleRegistrar,
	manifestHash,
	type NativeOperationOutcome,
	type NativeServiceController,
	type NativeServiceState,
	type ReadinessProbe,
	systemdStrategy,
	type VehicleRegistrationInput,
} from "../src/index.js";

function success(): NativeOperationOutcome {
	return { ok: true, diagnostics: [] };
}

function tempManifestPath(): string {
	return join(mkdtempSync(join(tmpdir(), "armada-registrar-")), "armada.json");
}

const RESTART = { policy: "on-failure" as const, delayMs: 1_000, maxAttempts: 3, windowMs: 60_000 };

function papyrus(overrides: Partial<VehicleRegistrationInput> = {}): VehicleRegistrationInput {
	return {
		name: "papyrus",
		version: "1.0.0",
		executable: "/opt/papyrus/cli.js",
		arguments: ["serve"],
		handlePath: "/run/user/1000/papyrus/handle.json",
		restart: RESTART,
		readiness: { timeoutMs: 5_000, pollIntervalMs: 100 },
		...overrides,
	};
}

/** A stateful fake controller -- remembers what it "installed" across calls, the way a real systemd/launchd/Task Scheduler controller's own on-disk descriptors would, so a second register() call sees the first one's actual effect. */
function statefulHarness() {
	const events: string[] = [];
	const installed = new Map<string, string>(); // name -> specHash
	const controller: NativeServiceController = {
		kind: "systemd",
		capabilities: systemdStrategy.capabilities,
		inspect: (vehicles) =>
			Promise.resolve({
				ok: true,
				services: vehicles.flatMap((v): NativeServiceState[] => {
					const specHash = installed.get(v.name);
					return specHash === undefined ? [] : [{ name: v.name, status: "running", specHash }];
				}),
				diagnostics: [],
			}),
		replaceDescriptorAtomically: (descriptor) => {
			events.push(`replace:${descriptor.identity}`);
			return Promise.resolve(success());
		},
		start: (identity) => {
			events.push(`start:${identity}`);
			return Promise.resolve(success());
		},
		stop: (identity) => {
			events.push(`stop:${identity}`);
			return Promise.resolve(success());
		},
		remove: (identity) => {
			events.push(`remove:${identity}`);
			return Promise.resolve(success());
		},
	};
	const readiness: ReadinessProbe = {
		waitUntilReady: (spec) => {
			events.push(`ready:${spec.name}`);
			installed.set(spec.name, manifestHash(spec));
			return Promise.resolve(success());
		},
	};
	return { controller, readiness, events };
}

describe("createVehicleRegistrar", () => {
	it("bootstraps a brand-new manifest file and installs the Vehicle natively", async () => {
		const manifestPath = tempManifestPath();
		const { controller, readiness, events } = statefulHarness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });

		const outcome = await registrar.register(papyrus());

		expect(outcome).toMatchObject({ ok: true, applied: [{ kind: "install", name: "papyrus" }] });
		expect(events).toEqual(["replace:armada-papyrus.service", "start:armada-papyrus.service", "ready:papyrus"]);
		const written = JSON.parse(readFileSync(manifestPath, "utf8")) as { vehicles: Array<{ name: string; version: string }> };
		expect(written.vehicles).toEqual([expect.objectContaining({ name: "papyrus", version: "1.0.0" })]);
	});

	it("reconciles an update (stop, replace, restart) when the declared version drifts from what's already running", async () => {
		const manifestPath = tempManifestPath();
		const { controller, readiness, events } = statefulHarness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });

		const first = await registrar.register(papyrus({ version: "1.0.0" }));
		expect(first.ok).toBe(true);
		events.length = 0;

		const second = await registrar.register(papyrus({ version: "1.1.0" }));

		expect(second).toMatchObject({ ok: true, applied: [{ kind: "update", name: "papyrus" }] });
		expect(events).toEqual([
			"stop:armada-papyrus.service",
			"replace:armada-papyrus.service",
			"start:armada-papyrus.service",
			"ready:papyrus",
		]);
	});

	it("is a no-op reconcile when register() is called again with an unchanged spec", async () => {
		const manifestPath = tempManifestPath();
		const { controller, readiness, events } = statefulHarness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });

		await registrar.register(papyrus());
		events.length = 0;
		const outcome = await registrar.register(papyrus());

		expect(outcome).toMatchObject({ ok: true, applied: [] });
		expect(events).toEqual([]);
	});

	it("fails closed on an invalid Vehicle without touching the native controller", async () => {
		const manifestPath = tempManifestPath();
		const { controller, readiness, events } = statefulHarness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });

		const outcome = await registrar.register(papyrus({ executable: "relative/not/absolute" }));

		expect(outcome.ok).toBe(false);
		expect(events).toEqual([]);
	});

	it("unregisters a registered Vehicle natively and from the manifest", async () => {
		const manifestPath = tempManifestPath();
		const { controller, readiness, events } = statefulHarness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });
		await registrar.register(papyrus());
		events.length = 0;

		const outcome = await registrar.unregister("papyrus");

		expect(outcome).toMatchObject({ ok: true });
		expect(events).toEqual(["remove:armada-papyrus.service"]);
		const written = JSON.parse(readFileSync(manifestPath, "utf8")) as { vehicles: unknown[] };
		expect(written.vehicles).toEqual([]);
	});

	it("unregister is idempotent for a name the manifest never knew about", async () => {
		const manifestPath = tempManifestPath();
		const { controller, readiness, events } = statefulHarness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });
		await registrar.register(papyrus());
		events.length = 0;

		const outcome = await registrar.unregister("never-registered");

		expect(outcome).toMatchObject({ ok: true, applied: [] });
		expect(events).toEqual([]);
	});
});
