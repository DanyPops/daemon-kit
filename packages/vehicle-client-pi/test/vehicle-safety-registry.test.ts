import { beforeEach, describe, expect, test } from "bun:test";
import {
	__resetVehicleSafetyRegistryForTests,
	claimVehicleSafetyCommandName,
	listVehicleSafetyContributors,
	registerVehicleSafetyContributor,
	unregisterVehicleSafetyContributor,
} from "../src/vehicle-safety-registry.ts";

beforeEach(() => {
	__resetVehicleSafetyRegistryForTests();
});

describe("registerVehicleSafetyContributor / listVehicleSafetyContributors", () => {
	test("starts empty", () => {
		expect(listVehicleSafetyContributors()).toEqual([]);
	});

	test("returns every registered contributor", () => {
		registerVehicleSafetyContributor({ source: "papyrus", resolve: () => ({ vehicleName: "papyrus", tools: [] }) });
		registerVehicleSafetyContributor({ source: "tickets", resolve: () => ({ vehicleName: "tickets", tools: [] }) });
		const sources = listVehicleSafetyContributors()
			.map((c) => c.source)
			.sort();
		expect(sources).toEqual(["papyrus", "tickets"]);
	});

	test("registering again under the same source replaces, never duplicates -- a refresh cycle doesn't accumulate stale copies", () => {
		const first = { source: "tickets", resolve: () => ({ vehicleName: "tickets", tools: [] }) };
		const second = { source: "tickets", resolve: () => ({ vehicleName: "tickets", tools: [] }) };
		registerVehicleSafetyContributor(first);
		registerVehicleSafetyContributor(second);
		const contributors = listVehicleSafetyContributors();
		expect(contributors).toHaveLength(1);
		expect(contributors[0]).toBe(second);
	});
});

describe("unregisterVehicleSafetyContributor", () => {
	test("removes a registered contributor", () => {
		registerVehicleSafetyContributor({ source: "pipes", resolve: () => ({ vehicleName: "pipes", tools: [] }) });
		unregisterVehicleSafetyContributor("pipes");
		expect(listVehicleSafetyContributors()).toEqual([]);
	});

	test("is idempotent for an already-absent source", () => {
		expect(() => unregisterVehicleSafetyContributor("nothing-here")).not.toThrow();
		expect(listVehicleSafetyContributors()).toEqual([]);
	});
});

describe("claimVehicleSafetyCommandName", () => {
	test("returns true for the first caller, false for every subsequent one", () => {
		expect(claimVehicleSafetyCommandName("safety")).toBe(true);
		expect(claimVehicleSafetyCommandName("safety")).toBe(false);
		expect(claimVehicleSafetyCommandName("safety")).toBe(false);
	});

	test("tracks each commandName independently", () => {
		expect(claimVehicleSafetyCommandName("safety")).toBe(true);
		expect(claimVehicleSafetyCommandName("other-safety")).toBe(true);
	});
});

describe("cross-module-instance sharing (the actual reason this uses globalThis)", () => {
	test("a second import of this same file (simulating a differently-versioned nested copy) sees the same state", async () => {
		registerVehicleSafetyContributor({ source: "papyrus", resolve: () => ({ vehicleName: "papyrus", tools: [] }) });
		const registryModule = await import("../src/vehicle-safety-registry.ts");
		expect(registryModule.listVehicleSafetyContributors().map((c) => c.source)).toEqual(["papyrus"]);
	});
});
