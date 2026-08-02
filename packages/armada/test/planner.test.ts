import { describe, expect, it } from "bun:test";
import { manifestHash, type NativeServiceState, planFleet } from "../src/index.js";
import { manifest, vehicle } from "./fixtures.js";

describe("planFleet", () => {
	it("plans stable install operations in Vehicle-name order", () => {
		const desired = manifest([vehicle({ name: "papyrus" }), vehicle({ name: "lector" })]);
		const first = planFleet(desired, []);
		const second = planFleet(desired, []);
		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.plan.operations.map((operation) => `${operation.kind}:${operation.name}`)).toEqual(["install:lector", "install:papyrus"]);
		expect(first.plan.planHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("produces an empty plan when native state has the desired spec hash", () => {
		const spec = vehicle();
		const actual: NativeServiceState = { name: spec.name, status: "running", specHash: manifestHash(spec), pid: 42 };
		const outcome = planFleet(manifest([spec]), [actual]);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.operations).toEqual([]);
	});

	it("plans update, start, and restart from actual state", () => {
		const specs = [vehicle({ name: "update" }), vehicle({ name: "start" }), vehicle({ name: "restart" })];
		const actual: NativeServiceState[] = [
			{ name: specs[0]!.name, status: "running", specHash: "stale" },
			{ name: specs[1]!.name, status: "stopped", specHash: manifestHash(specs[1]!) },
			{ name: specs[2]!.name, status: "failed", specHash: manifestHash(specs[2]!) },
		];
		const outcome = planFleet(manifest(specs), actual);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.operations.map((operation) => `${operation.kind}:${operation.name}`)).toEqual([
			"restart:restart",
			"start:start",
			"update:update",
		]);
	});

	it("rejects duplicate and unbounded actual state", () => {
		const spec = vehicle();
		expect(
			planFleet(manifest([spec]), [
				{ name: spec.name, status: "running" },
				{ name: spec.name, status: "stopped" },
			]).ok,
		).toBe(false);
		expect(
			planFleet(
				manifest([spec]),
				Array.from({ length: 101 }, () => ({ name: spec.name, status: "running" as const })),
			).ok,
		).toBe(false);
	});
});
