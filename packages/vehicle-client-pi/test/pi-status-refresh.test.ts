import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerVehicleStatusRefresh } from "../src/pi-status-refresh.ts";

function fakePi() {
	const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void>> = {};
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
			handlers[event] = handler;
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

const fakeCtx = {} as ExtensionContext;

describe("registerVehicleStatusRefresh", () => {
	it("refreshes on session_start", async () => {
		const { pi, handlers } = fakePi();
		let calls = 0;
		registerVehicleStatusRefresh(pi, { ownToolPrefixes: ["foo_"], refresh: () => void calls++ });
		await handlers.session_start!({ type: "session_start" }, fakeCtx);
		expect(calls).toBe(1);
	});

	it("refreshes again after one of its own tools runs", async () => {
		const { pi, handlers } = fakePi();
		let calls = 0;
		registerVehicleStatusRefresh(pi, { ownToolPrefixes: ["foo_"], refresh: () => void calls++ });
		await handlers.tool_execution_end!({ type: "tool_execution_end", toolName: "foo_bar" }, fakeCtx);
		expect(calls).toBe(1);
	});

	it("ignores a tool call that isn't one of its own", async () => {
		const { pi, handlers } = fakePi();
		let calls = 0;
		registerVehicleStatusRefresh(pi, { ownToolPrefixes: ["foo_"], refresh: () => void calls++ });
		await handlers.tool_execution_end!({ type: "tool_execution_end", toolName: "read" }, fakeCtx);
		expect(calls).toBe(0);
	});

	it("matches against any of several prefixes", async () => {
		const { pi, handlers } = fakePi();
		let calls = 0;
		registerVehicleStatusRefresh(pi, { ownToolPrefixes: ["foo_", "bar_"], refresh: () => void calls++ });
		await handlers.tool_execution_end!({ type: "tool_execution_end", toolName: "bar_baz" }, fakeCtx);
		expect(calls).toBe(1);
	});

	it("swallows a refresh failure instead of throwing", async () => {
		const { pi, handlers } = fakePi();
		registerVehicleStatusRefresh(pi, {
			ownToolPrefixes: ["foo_"],
			refresh: () => {
				throw new Error("daemon unreachable");
			},
		});
		await expect(handlers.session_start!({ type: "session_start" }, fakeCtx)).resolves.toBeUndefined();
	});

	it("swallows a rejected async refresh", async () => {
		const { pi, handlers } = fakePi();
		registerVehicleStatusRefresh(pi, {
			ownToolPrefixes: ["foo_"],
			refresh: async () => {
				throw new Error("daemon unreachable");
			},
		});
		await expect(handlers.session_start!({ type: "session_start" }, fakeCtx)).resolves.toBeUndefined();
	});
});
