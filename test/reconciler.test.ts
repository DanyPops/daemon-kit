import { describe, expect, it } from "vitest";
import {
	manifestHash,
	planFleet,
	reconcileFleet,
	systemdStrategy,
	type NativeOperationOutcome,
	type NativeServiceController,
	type NativeServiceState,
	type ReadinessProbe,
} from "../src/index.js";
import { manifest, vehicle } from "./fixtures.js";

function success(): NativeOperationOutcome {
	return { ok: true, diagnostics: [] };
}

function harness(actual: NativeServiceState[] = []) {
	const events: string[] = [];
	const controller: NativeServiceController = {
		kind: "systemd",
		capabilities: systemdStrategy.capabilities,
		inspect: () => Promise.resolve({ ok: true, services: actual, diagnostics: [] }),
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
	};
	const readiness: ReadinessProbe = {
		waitUntilReady: (spec) => {
			events.push(`ready:${spec.name}`);
			return Promise.resolve(success());
		},
	};
	return { controller, readiness, events };
}

describe("reconcileFleet", () => {
	it("installs, starts, and verifies readiness under one native identity", async () => {
		const desired = manifest();
		const planned = planFleet(desired, []);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const { controller, readiness, events } = harness();
		const outcome = await reconcileFleet({
			manifest: desired,
			plan: planned.plan,
			strategy: systemdStrategy,
			controller,
			readCurrentManifestHash: () => Promise.resolve({ ok: true, hash: desired.contentHash }),
			readiness,
		});
		expect(outcome).toMatchObject({ ok: true, applied: [{ kind: "install", name: "papyrus" }] });
		expect(events).toEqual([
			"replace:armada-papyrus.service",
			"start:armada-papyrus.service",
			"ready:papyrus",
		]);
	});

	it("stops before atomically replacing an updated descriptor", async () => {
		const spec = vehicle();
		const desired = manifest([spec]);
		const actual = [{ name: spec.name, status: "running" as const, specHash: "stale" }];
		const planned = planFleet(desired, actual);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const { controller, readiness, events } = harness(actual);
		const outcome = await reconcileFleet({
			manifest: desired,
			plan: planned.plan,
			strategy: systemdStrategy,
			controller,
			readCurrentManifestHash: () => Promise.resolve({ ok: true, hash: desired.contentHash }),
			readiness,
		});
		expect(outcome.ok).toBe(true);
		expect(events).toEqual([
			"stop:armada-papyrus.service",
			"replace:armada-papyrus.service",
			"start:armada-papyrus.service",
			"ready:papyrus",
		]);
	});

	it("rejects stale manifest and actual-state plans before mutation", async () => {
		const desired = manifest();
		const planned = planFleet(desired, []);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const staleManifest = harness();
		const first = await reconcileFleet({
			manifest: desired,
			plan: planned.plan,
			strategy: systemdStrategy,
			controller: staleManifest.controller,
			readCurrentManifestHash: () => Promise.resolve({ ok: true, hash: manifestHash({ changed: true }) }),
			readiness: staleManifest.readiness,
		});
		expect(first).toMatchObject({ ok: false, diagnostics: [{ code: "RECONCILE_MANIFEST_STALE" }] });
		expect(staleManifest.events).toEqual([]);

		const changedActual = harness([{ name: desired.vehicles[0]!.name, status: "running", specHash: manifestHash(desired.vehicles[0]!) }]);
		const second = await reconcileFleet({
			manifest: desired,
			plan: planned.plan,
			strategy: systemdStrategy,
			controller: changedActual.controller,
			readCurrentManifestHash: () => Promise.resolve({ ok: true, hash: desired.contentHash }),
			readiness: changedActual.readiness,
		});
		expect(second).toMatchObject({ ok: false, diagnostics: [{ code: "RECONCILE_PLAN_STALE" }] });
		expect(changedActual.events).toEqual([]);
	});

	it("is a no-op when desired and actual state are converged", async () => {
		const spec = vehicle();
		const desired = manifest([spec]);
		const actual = [{ name: spec.name, status: "running" as const, specHash: manifestHash(spec) }];
		const planned = planFleet(desired, actual);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const { controller, readiness, events } = harness(actual);
		const outcome = await reconcileFleet({
			manifest: desired,
			plan: planned.plan,
			strategy: systemdStrategy,
			controller,
			readCurrentManifestHash: () => Promise.resolve({ ok: true, hash: desired.contentHash }),
			readiness,
		});
		expect(outcome).toMatchObject({ ok: true, applied: [] });
		expect(events).toEqual([]);
	});
});
