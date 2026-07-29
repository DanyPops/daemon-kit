import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { syncManagedActiveTools } from "../src/pi-tool-availability.ts";

function fakePi(initiallyActive: string[]) {
	let active = [...initiallyActive];
	const setCalls: string[][] = [];
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			setCalls.push([...names]);
			active = [...names];
		},
	} as unknown as ExtensionAPI;
	return { pi, setCalls, activeTools: () => [...active] };
}

describe("syncManagedActiveTools", () => {
	it("never touches a tool this call doesn't manage", () => {
		const { pi, activeTools } = fakePi(["read", "edit", "vehicle_a"]);
		syncManagedActiveTools(pi, ["vehicle_a", "vehicle_b"], ["vehicle_b"]);
		expect(activeTools().sort()).toEqual(["edit", "read", "vehicle_b"]);
	});

	it("removes a managed tool that's no longer desired", () => {
		const { pi, activeTools } = fakePi(["read", "vehicle_a"]);
		syncManagedActiveTools(pi, ["vehicle_a"], []);
		expect(activeTools()).toEqual(["read"]);
	});

	it("adds a managed tool that's newly desired, even if never active before", () => {
		const { pi, activeTools } = fakePi(["read"]);
		syncManagedActiveTools(pi, ["vehicle_a"], ["vehicle_a"]);
		expect(activeTools().sort()).toEqual(["read", "vehicle_a"]);
	});

	it("skips calling setActiveTools entirely when nothing would actually change", () => {
		const { pi, setCalls } = fakePi(["read", "vehicle_a"]);
		syncManagedActiveTools(pi, ["vehicle_a"], ["vehicle_a"]);
		expect(setCalls).toEqual([]);
	});

	it("throws if a desired-active name isn't declared as managed -- a caller bug, not silently accepted", () => {
		const { pi } = fakePi(["read"]);
		expect(() => syncManagedActiveTools(pi, ["vehicle_a"], ["vehicle_b"])).toThrow("not in managedToolNames");
	});
});
