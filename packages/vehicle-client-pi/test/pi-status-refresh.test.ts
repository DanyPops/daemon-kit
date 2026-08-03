import { describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { registerVehicleStatusRefresh } from "../src/pi-status-refresh.ts";

function harnessFor(options: Parameters<typeof registerVehicleStatusRefresh>[1]) {
	return createExtensionHarness((pi) => registerVehicleStatusRefresh(pi, options));
}

describe("registerVehicleStatusRefresh", () => {
	it("refreshes on session_start", async () => {
		let calls = 0;
		const h = harnessFor({ ownToolPrefixes: ["foo_"], refresh: () => void calls++ });
		await h.emit("session_start");
		expect(calls).toBe(1);
	});

	it("refreshes again after one of its own tools runs", async () => {
		let calls = 0;
		const h = harnessFor({ ownToolPrefixes: ["foo_"], refresh: () => void calls++ });
		await h.emit("tool_execution_end", { toolName: "foo_bar" });
		expect(calls).toBe(1);
	});

	it("ignores a tool call that isn't one of its own", async () => {
		let calls = 0;
		const h = harnessFor({ ownToolPrefixes: ["foo_"], refresh: () => void calls++ });
		await h.emit("tool_execution_end", { toolName: "read" });
		expect(calls).toBe(0);
	});

	it("matches against any of several prefixes", async () => {
		let calls = 0;
		const h = harnessFor({ ownToolPrefixes: ["foo_", "bar_"], refresh: () => void calls++ });
		await h.emit("tool_execution_end", { toolName: "bar_baz" });
		expect(calls).toBe(1);
	});

	it("swallows a refresh failure instead of throwing", async () => {
		const h = harnessFor({
			ownToolPrefixes: ["foo_"],
			refresh: () => {
				throw new Error("daemon unreachable");
			},
		});
		await expect(h.emit("session_start")).resolves.toBeUndefined();
	});

	it("swallows a rejected async refresh", async () => {
		const h = harnessFor({
			ownToolPrefixes: ["foo_"],
			refresh: async () => {
				throw new Error("daemon unreachable");
			},
		});
		await expect(h.emit("session_start")).resolves.toBeUndefined();
	});
});
