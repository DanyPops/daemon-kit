import { describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { syncManagedActiveTools } from "../src/pi-tool-availability.ts";

function harnessWith(initiallyActive: string[]) {
	return createExtensionHarness(() => {}, { initialActiveTools: initiallyActive });
}

describe("syncManagedActiveTools", () => {
	it("never touches a tool this call doesn't manage", () => {
		const h = harnessWith(["read", "edit", "vehicle_a"]);
		syncManagedActiveTools(h.api, ["vehicle_a", "vehicle_b"], ["vehicle_b"]);
		expect(h.activeTools.sort()).toEqual(["edit", "read", "vehicle_b"]);
	});

	it("removes a managed tool that's no longer desired", () => {
		const h = harnessWith(["read", "vehicle_a"]);
		syncManagedActiveTools(h.api, ["vehicle_a"], []);
		expect(h.activeTools).toEqual(["read"]);
	});

	it("adds a managed tool that's newly desired, even if never active before", () => {
		const h = harnessWith(["read"]);
		syncManagedActiveTools(h.api, ["vehicle_a"], ["vehicle_a"]);
		expect(h.activeTools.sort()).toEqual(["read", "vehicle_a"]);
	});

	it("skips calling setActiveTools entirely when nothing would actually change", () => {
		const h = harnessWith(["read", "vehicle_a"]);
		syncManagedActiveTools(h.api, ["vehicle_a"], ["vehicle_a"]);
		expect(h.activeToolsHistory).toEqual([]);
	});

	it("throws if a desired-active name isn't declared as managed -- a caller bug, not silently accepted", () => {
		const h = harnessWith(["read"]);
		expect(() => syncManagedActiveTools(h.api, ["vehicle_a"], ["vehicle_b"])).toThrow("not in managedToolNames");
	});
});
