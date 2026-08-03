import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVehicleRegistrar, type NativeOperationOutcome, type NativeServiceController, type ReadinessProbe, systemdStrategy } from "../src/index.js";

function success(): NativeOperationOutcome {
	return { ok: true, diagnostics: [] };
}

function harness() {
	const controller: NativeServiceController = {
		kind: "systemd",
		capabilities: systemdStrategy.capabilities,
		inspect: () => Promise.resolve({ ok: true, services: [], diagnostics: [] }),
		replaceDescriptorAtomically: () => Promise.resolve(success()),
		start: () => Promise.resolve(success()),
		stop: () => Promise.resolve(success()),
		remove: () => Promise.resolve(success()),
	};
	const readiness: ReadinessProbe = { waitUntilReady: () => Promise.resolve(success()) };
	return { controller, readiness };
}

describe("createVehicleRegistrar().isRegistered", () => {
	it("is false before register() and before the manifest file exists at all", async () => {
		const manifestPath = join(mkdtempSync(join(tmpdir(), "armada-isregistered-")), "armada.json");
		const { controller, readiness } = harness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });

		expect(await registrar.isRegistered("papyrus")).toBe(false);
	});

	it("is true once registered, and false again after unregister()", async () => {
		const manifestPath = join(mkdtempSync(join(tmpdir(), "armada-isregistered-")), "armada.json");
		const { controller, readiness } = harness();
		const registrar = createVehicleRegistrar({ manifestPath, controller, readiness });
		await registrar.register({
			name: "papyrus",
			version: "1.0.0",
			executable: "/opt/papyrus/cli.js",
			handlePath: "/run/user/1000/papyrus/handle.json",
			restart: { policy: "never" },
			readiness: { timeoutMs: 5_000, pollIntervalMs: 100 },
		});

		expect(await registrar.isRegistered("papyrus")).toBe(true);

		await registrar.unregister("papyrus");
		expect(await registrar.isRegistered("papyrus")).toBe(false);
	});
});
