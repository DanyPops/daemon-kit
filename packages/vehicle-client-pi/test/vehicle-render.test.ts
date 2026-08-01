import { describe, expect, it } from "bun:test";
import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderVehicleCall, renderVehicleResult } from "../src/vehicle-render.ts";

// Theme is a class with private fields; a plain fake can't satisfy it
// structurally. Cast through unknown -- documented, not a real runtime
// concern, since only fg()/bold() are ever called by vehicle-render.ts.
// Differentiates tokens (rather than an identity function) so tests exercise
// real cascade behavior instead of always hitting the hardcoded fallback.
const fakeTheme = {
	fg: (color: string, text: string) => (color === "text" ? text : `<${color}>${text}`),
	bold: (text: string) => text,
} as unknown as Theme;

// Every fg() call resolves to the baseline (identity) -- simulates a theme
// that never defines any semantic token distinctly from plain text.
const flatTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function descriptor(effect: VehicleEffect, overrides: Partial<VehicleOperationDescriptor> = {}): VehicleOperationDescriptor {
	return {
		name: "issue.list",
		version: 1,
		description: "List issues.",
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		permissions: [],
		effect,
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
		...overrides,
	};
}

function callContext(overrides: Record<string, unknown> = {}) {
	return { cwd: "/tmp", isError: false, isPartial: false, expanded: false, ...overrides } as never;
}

describe("renderVehicleCall", () => {
	it("includes the operation name and compact args", () => {
		const component = renderVehicleCall(descriptor("read"), { backend: "github" }, fakeTheme, callContext());
		expect(component.render(80).join("\n")).toContain("issue.list");
		expect(component.render(80).join("\n")).toContain('"backend":"github"');
	});

	it("omits the args snippet for an empty-object call", () => {
		const component = renderVehicleCall(descriptor("read"), {}, fakeTheme, callContext());
		expect(component.render(80)).toEqual(["<muted>issue.list"]);
	});

	it("falls back to a hardcoded ANSI color when the theme never distinguishes any candidate token from plain text", () => {
		const component = renderVehicleCall(descriptor("destructive"), {}, flatTheme, callContext());
		expect(component.render(80)[0]).toContain("\x1b[31m");
	});
});

describe("renderVehicleResult", () => {
	function resultContext(overrides: Record<string, unknown> = {}) {
		return { cwd: "/tmp", isError: false, ...overrides } as never;
	}

	it("renders a ProgressBar for a partial result with a {current,total} shaped progress payload", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { progress: { current: 3, total: 10 } } },
			{ isPartial: true, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const line = component.render(40).join("\n");
		expect(line).toContain("30%");
	});

	it("renders a Table for an array-of-objects output", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{
				content: [],
				details: {
					output: [
						{ id: "1", title: "First" },
						{ id: "2", title: "Second" },
					],
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("id");
		expect(text).toContain("title");
		expect(text).toContain("First");
		expect(text).toContain("Second");
	});

	it("falls back to collapsible JSON for a non-tabular output", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { ok: true } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain('"ok": true');
	});

	it("expands the collapsible JSON view when options.expanded is true", () => {
		const longOutput = { lines: Array.from({ length: 20 }, (_, i) => `line-${i}`) };
		const collapsed = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: longOutput } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const expanded = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: longOutput } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		expect(expanded.render(80).length).toBeGreaterThan(collapsed.render(80).length);
	});

	it("renders error content plainly when the context reports an error, ignoring output shape", () => {
		const component = renderVehicleResult(
			descriptor("external-write"),
			{ content: [{ type: "text", text: "backend unreachable" }], details: {} },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext({ isError: true }),
		);
		expect(component.render(80).join("\n")).toContain("backend unreachable");
	});
});
