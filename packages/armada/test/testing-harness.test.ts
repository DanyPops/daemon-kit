import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createArmadaTestHarness } from "../src/testing.js";

const vehicle = {
	name: "mock-vehicle",
	version: "1.0.0",
	executable: "/opt/mock-vehicle/cli.js",
	arguments: ["serve"],
	handlePath: "/tmp/mock-vehicle/handle.json",
	restart: { policy: "on-failure" as const, delayMs: 100, maxAttempts: 2, windowMs: 1_000 },
	readiness: { timeoutMs: 100, pollIntervalMs: 50 },
};

describe("createArmadaTestHarness", () => {
	it("drives the real registrar and reconciler through an isolated stateful native controller", async () => {
		const harness = await createArmadaTestHarness();
		try {
			const outcome = await harness.registrar.register(vehicle);
			expect(outcome).toMatchObject({ ok: true, applied: [{ kind: "install", name: "mock-vehicle" }] });
			expect(harness.events()).toEqual([
				"replace:armada-mock-vehicle.service",
				"start:armada-mock-vehicle.service",
				"ready:mock-vehicle",
			]);
			expect(harness.application("mock-vehicle").state()).toBe("ready");
			expect(await harness.status()).toMatchObject({
				vehicles: [{ name: "mock-vehicle", nativeStatus: "running", ready: true, descriptorDrift: false }],
			});
			const manifest = JSON.parse(await readFile(harness.manifestPath, "utf8")) as { vehicles: Array<{ name: string }> };
			expect(manifest.vehicles.map((item) => item.name)).toEqual(["mock-vehicle"]);
		} finally {
			await harness.dispose();
		}
	});

	it("holds reconciliation at a deterministic readiness gate until the mock application is marked ready", async () => {
		const harness = await createArmadaTestHarness({ readiness: "manual" });
		try {
			let settled = false;
			const registering = harness.registrar.register(vehicle).finally(() => {
				settled = true;
			});
			await harness.waitForEvent("ready-wait:mock-vehicle");
			expect(settled).toBe(false);
			expect(harness.application("mock-vehicle").state()).toBe("starting");

			harness.application("mock-vehicle").markReady();
			expect(await registering).toMatchObject({ ok: true });
			expect(harness.application("mock-vehicle").state()).toBe("ready");
		} finally {
			await harness.dispose();
		}
	});

	it("models readiness timeout, crash, clean exit, and restart without a live service manager", async () => {
		const harness = await createArmadaTestHarness({ readiness: "timeout" });
		try {
			const timedOut = await harness.registrar.register(vehicle);
			expect(timedOut).toMatchObject({ ok: false, diagnostics: [{ code: "VEHICLE_READINESS_TIMEOUT" }] });

			const app = harness.application("mock-vehicle");
			app.crash();
			expect(app.state()).toBe("crashed");
			expect(await harness.status()).toMatchObject({ vehicles: [{ nativeStatus: "failed", ready: false }] });
			app.restart();
			expect(app.state()).toBe("starting");
			app.exitCleanly();
			expect(app.state()).toBe("exited");
		} finally {
			await harness.dispose();
		}
	});

	it("removes every isolated artifact during bounded teardown", async () => {
		const harness = await createArmadaTestHarness();
		const root = harness.root;
		expect(existsSync(root)).toBe(true);
		await harness.dispose();
		expect(existsSync(root)).toBe(false);
	});
});
