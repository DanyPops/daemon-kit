import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { VehicleSafetyPolicyStore } from "../src/vehicle-safety.ts";
import {
	buildAllowedViewTableRows,
	buildAllViewTableRows,
	buildByEffectViewGroups,
	buildVehicleSafetyRows,
	findOperationName,
	findRowByLabel,
	nextVehicleSafetySortKey,
	operationLabel,
	runVehicleSafetyCommand,
	sortVehicleSafetyRows,
	toolNamespace,
	type VehicleSafetyRow,
} from "../src/vehicle-safety-command.ts";
import {
	__resetVehicleSafetyRegistryForTests,
	type VehicleSafetyContribution,
	type VehicleSafetyContributor,
} from "../src/vehicle-safety-registry.ts";

beforeEach(() => {
	__resetVehicleSafetyRegistryForTests();
});

describe("toolNamespace", () => {
	test("returns the prefix before the first dot", () => {
		expect(toolNamespace("issues.search")).toBe("issues");
	});

	test("returns the whole name when there's no dot", () => {
		expect(toolNamespace("search")).toBe("search");
	});
});

describe("operationLabel / findRowByLabel", () => {
	test("round-trips a row through its label", () => {
		const row: VehicleSafetyRow = { tool: "issues", command: "issues_search", state: "allow", vehicle: "papyrus", effect: "read" };
		expect(operationLabel(row)).toBe("papyrus/issues_search");
		expect(findRowByLabel([row], "papyrus/issues_search")).toBe(row);
	});

	test("returns undefined for an unknown label", () => {
		expect(findRowByLabel([], "papyrus/nothing")).toBeUndefined();
	});
});

describe("findOperationName", () => {
	test("resolves a row's real operationName from its contribution", () => {
		const contributions: VehicleSafetyContribution[] = [
			{ vehicleName: "papyrus", tools: [{ toolName: "issues_search", operationName: "issues.search", effect: "read", state: "allow" }] },
		];
		expect(findOperationName(contributions, { vehicle: "papyrus", command: "issues_search" })).toBe("issues.search");
	});

	test("falls back to the toolName when no matching contribution/tool is found", () => {
		expect(findOperationName([], { vehicle: "papyrus", command: "issues_search" })).toBe("issues_search");
	});
});

describe("buildVehicleSafetyRows", () => {
	test("flattens every contribution's tools into rows", () => {
		const contributions: VehicleSafetyContribution[] = [
			{ vehicleName: "papyrus", tools: [{ toolName: "issues_search", operationName: "issues.search", effect: "read", state: "allow" }] },
			{
				vehicleName: "tickets",
				tools: [{ toolName: "risk_destructive", operationName: "risk.destructive", effect: "destructive", state: "ask" }],
			},
		];
		expect(buildVehicleSafetyRows(contributions)).toEqual([
			{ tool: "issues", command: "issues_search", state: "allow", vehicle: "papyrus", effect: "read" },
			{ tool: "risk", command: "risk_destructive", state: "ask", vehicle: "tickets", effect: "destructive" },
		]);
	});
});

const ROWS: VehicleSafetyRow[] = [
	{ tool: "issues", command: "issues_write", state: "blocked", vehicle: "tickets", effect: "external-write" },
	{ tool: "issues", command: "issues_search", state: "allow", vehicle: "papyrus", effect: "read" },
	{ tool: "risk", command: "risk_destructive", state: "ask", vehicle: "papyrus", effect: "destructive" },
];

describe("sortVehicleSafetyRows / nextVehicleSafetySortKey", () => {
	test("sorts by namespace (tool) by default", () => {
		expect(sortVehicleSafetyRows(ROWS, "namespace").map((r) => r.command)).toEqual(["issues_search", "issues_write", "risk_destructive"]);
	});

	test("sorts by vehicle", () => {
		expect(sortVehicleSafetyRows(ROWS, "vehicle").map((r) => r.vehicle)).toEqual(["papyrus", "papyrus", "tickets"]);
	});

	test("sorts by state, blocked first then ask then allow", () => {
		expect(sortVehicleSafetyRows(ROWS, "state").map((r) => r.state)).toEqual(["blocked", "ask", "allow"]);
	});

	test("never mutates the input array", () => {
		const copy = [...ROWS];
		sortVehicleSafetyRows(ROWS, "state");
		expect(ROWS).toEqual(copy);
	});

	test("cycles namespace -> vehicle -> state -> namespace", () => {
		expect(nextVehicleSafetySortKey("namespace")).toBe("vehicle");
		expect(nextVehicleSafetySortKey("vehicle")).toBe("state");
		expect(nextVehicleSafetySortKey("state")).toBe("namespace");
	});
});

describe("per-view row/column shaping", () => {
	test("All view keeps every row and column, state included", () => {
		expect(buildAllViewTableRows(ROWS)).toEqual([
			{ tool: "issues", command: "issues_write", state: "blocked", vehicle: "tickets", effect: "external-write" },
			{ tool: "issues", command: "issues_search", state: "allow", vehicle: "papyrus", effect: "read" },
			{ tool: "risk", command: "risk_destructive", state: "ask", vehicle: "papyrus", effect: "destructive" },
		]);
	});

	test("Allowed view filters to allow-state rows only, dropping the now-redundant state column", () => {
		expect(buildAllowedViewTableRows(ROWS)).toEqual([{ tool: "issues", command: "issues_search", vehicle: "papyrus", effect: "read" }]);
	});

	test("By effect view groups by effect, simplifying state to a yes/no 'allowed' column", () => {
		expect(buildByEffectViewGroups(ROWS)).toEqual([
			{ effect: "external-write", rows: [{ tool: "issues", command: "issues_write", allowed: "no" }] },
			{ effect: "read", rows: [{ tool: "issues", command: "issues_search", allowed: "yes" }] },
			{ effect: "destructive", rows: [{ tool: "risk", command: "risk_destructive", allowed: "no" }] },
		]);
	});
});

function fakeContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: { notify: () => {}, select: async () => undefined, confirm: async () => false, input: async () => undefined },
		...overrides,
	} as unknown as ExtensionCommandContext;
}

describe("runVehicleSafetyCommand", () => {
	test("notifies and returns immediately when no Vehicle has registered anything yet", async () => {
		const notified: string[] = [];
		const ctx = fakeContext({ ui: { notify: (msg: string) => notified.push(msg) } as never });
		const policyStore = await VehicleSafetyPolicyStore.restore();

		await runVehicleSafetyCommand(ctx, { policyStore, contributors: () => [] });

		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain("No Vehicle tools registered");
	});

	test("a non-tui mode gets a plain notify() summary instead of opening a panel", async () => {
		const notified: string[] = [];
		const ctx = fakeContext({ mode: "print", ui: { notify: (msg: string) => notified.push(msg) } as never });
		const policyStore = await VehicleSafetyPolicyStore.restore();
		const contributor: VehicleSafetyContributor = {
			source: "papyrus",
			resolve: () => ({
				vehicleName: "papyrus",
				tools: [{ toolName: "issues_search", operationName: "issues.search", effect: "read", state: "allow" }],
			}),
		};

		await runVehicleSafetyCommand(ctx, { policyStore, contributors: () => [contributor] });

		expect(notified[0]).toContain("papyrus/issues_search: allow");
	});

	test("closing the panel (no edit) returns without touching the policy store", async () => {
		const ctx = fakeContext();
		const policyStore = await VehicleSafetyPolicyStore.restore();
		const contributor: VehicleSafetyContributor = {
			source: "papyrus",
			resolve: () => ({
				vehicleName: "papyrus",
				tools: [{ toolName: "issues_search", operationName: "issues.search", effect: "read", state: "allow" }],
			}),
		};

		await runVehicleSafetyCommand(ctx, { policyStore, contributors: () => [contributor], showPanel: async () => undefined });

		expect(policyStore.list()).toEqual([]);
	});

	test("edit -> pick operation -> pick state persists an override, then reopens the panel with the updated state", async () => {
		const ctx = fakeContext();
		const policyStore = await VehicleSafetyPolicyStore.restore();
		const contributor: VehicleSafetyContributor = {
			source: "papyrus",
			resolve: () => ({
				vehicleName: "papyrus",
				tools: [{ toolName: "issues_search", operationName: "issues.search", effect: "read", state: "allow" }],
			}),
		};
		let panelCalls = 0;
		const seenRowsPerCall: string[][] = [];

		await runVehicleSafetyCommand(ctx, {
			policyStore,
			contributors: () => [contributor],
			showPanel: async (_ctx, rows) => {
				panelCalls++;
				seenRowsPerCall.push(rows.map((r) => r.state));
				return panelCalls === 1 ? "edit" : undefined;
			},
			pickOperationToEdit: async (_ctx, rows) => rows[0],
			pickNewState: async () => "blocked",
		});

		expect(panelCalls).toBe(2);
		expect(policyStore.get("papyrus", "issues.search")).toBe("blocked");
		// The panel reopened after the edit shows the freshly-resolved (still "allow" from
		// the contributor's own resolve(), since nothing re-registered) state -- the real
		// effect of the override only shows up once registerVehicleTools/refresh re-reads
		// the policy store on its own next call, exactly as documented.
		expect(seenRowsPerCall).toEqual([["allow"], ["allow"]]);
	});

	test("declining to pick an operation or a new state loops back to the panel without writing anything", async () => {
		const ctx = fakeContext();
		const policyStore = await VehicleSafetyPolicyStore.restore();
		const contributor: VehicleSafetyContributor = {
			source: "papyrus",
			resolve: () => ({
				vehicleName: "papyrus",
				tools: [{ toolName: "issues_search", operationName: "issues.search", effect: "read", state: "allow" }],
			}),
		};
		let panelCalls = 0;

		await runVehicleSafetyCommand(ctx, {
			policyStore,
			contributors: () => [contributor],
			showPanel: async () => {
				panelCalls++;
				return panelCalls === 1 ? "edit" : undefined;
			},
			pickOperationToEdit: async () => undefined,
		});

		expect(policyStore.list()).toEqual([]);
	});
});
