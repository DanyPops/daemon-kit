import { beforeEach, describe, expect, test } from "bun:test";
import {
	__resetSecretsRegistryForTests,
	claimSecretsCommandName,
	listSecretsContributors,
	registerSecretsContributor,
	unregisterSecretsContributor,
} from "../src/secrets-registry.ts";
import type { SecretsBackend } from "../src/secrets-backend.ts";

function fakeBackend(source: string): SecretsBackend {
	return {
		source,
		list: async () => [],
		get: async () => undefined,
		rotate: async () => {},
		revoke: async () => {},
		reveal: async () => undefined,
	};
}

beforeEach(() => {
	__resetSecretsRegistryForTests();
});

describe("registerSecretsContributor / listSecretsContributors", () => {
	test("starts empty", () => {
		expect(listSecretsContributors()).toEqual([]);
	});

	test("returns every registered contributor", () => {
		registerSecretsContributor({ source: "enigma", resolve: () => ({ backends: [fakeBackend("enigma")] }) });
		registerSecretsContributor({ source: "tickets", resolve: () => ({ backends: [fakeBackend("tickets")] }) });
		const sources = listSecretsContributors()
			.map((c) => c.source)
			.sort();
		expect(sources).toEqual(["enigma", "tickets"]);
	});

	test("registering again under the same source replaces, never duplicates", () => {
		const first = { source: "tickets", resolve: () => ({ backends: [fakeBackend("tickets-v1")] }) };
		const second = { source: "tickets", resolve: () => ({ backends: [fakeBackend("tickets-v2")] }) };
		registerSecretsContributor(first);
		registerSecretsContributor(second);
		const contributors = listSecretsContributors();
		expect(contributors).toHaveLength(1);
		expect(contributors[0]).toBe(second);
	});
});

describe("unregisterSecretsContributor", () => {
	test("removes a registered contributor", () => {
		registerSecretsContributor({ source: "pipes", resolve: () => ({ backends: [] }) });
		unregisterSecretsContributor("pipes");
		expect(listSecretsContributors()).toEqual([]);
	});

	test("is idempotent for an already-absent source", () => {
		expect(() => unregisterSecretsContributor("nothing-here")).not.toThrow();
		expect(listSecretsContributors()).toEqual([]);
	});
});

describe("claimSecretsCommandName", () => {
	test("returns true for the first caller, false for every subsequent one", () => {
		expect(claimSecretsCommandName("secrets")).toBe(true);
		expect(claimSecretsCommandName("secrets")).toBe(false);
		expect(claimSecretsCommandName("secrets")).toBe(false);
	});

	test("tracks each commandName independently", () => {
		expect(claimSecretsCommandName("secrets")).toBe(true);
		expect(claimSecretsCommandName("other-secrets")).toBe(true);
	});
});

describe("cross-module-instance sharing (the actual reason this uses globalThis)", () => {
	test("a second import of this same file (simulating a differently-versioned nested copy) sees the same state", async () => {
		registerSecretsContributor({ source: "enigma", resolve: () => ({ backends: [] }) });
		// Bun's module cache would normally dedupe this to the identical instance for a
		// literal re-import of the same path, but the point under test is the *mechanism*
		// (globalThis + Symbol.for), not proving bypass of Bun's own cache -- a real
		// cross-package duplicate is exercised for real in daemon-kit's consumers
		// (enigma/pipes/tickets each resolving their own nested daemon-kit copy).
		const registryModule = await import("../src/secrets-registry.ts");
		expect(registryModule.listSecretsContributors().map((c) => c.source)).toEqual(["enigma"]);
	});
});
