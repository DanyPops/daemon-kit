import { describe, expect, it } from "bun:test";
import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { renderVehicleCall, renderVehicleResult } from "../src/vehicle-render.ts";

// keyHint() (used by the row-truncation "more" note) reads pi's global theme singleton,
// independent of the fakeTheme/flatTheme fakes below -- it throws "Theme not initialized" without this.
initTheme();

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

	it("shows a clear message for an empty array output, not raw JSON '[]'", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: [] } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).not.toContain("[]");
		expect(text.toLowerCase()).toContain("no results");
	});

	it("bounds a large array output to the default visible row count and reports how many more remain, using Pi's own expanded flag", () => {
		const rows = Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}` }));
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: rows } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("row-0");
		expect(text).not.toContain("row-29"); // well past the default visible cap
		expect(text).toContain("more");
	});

	it("shows every row with no truncation note when expanded is true", () => {
		const rows = Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}` }));
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: rows } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("row-29");
		expect(text).not.toContain("more");
	});

	it("adds no truncation note when the array is already under the default visible row count", () => {
		const rows = Array.from({ length: 3 }, (_, i) => ({ id: `${i}` }));
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: rows } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).not.toContain("more");
	});

	it("renders a bounded bullet list for an array-of-plain-strings output, not a raw JSON dump", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: ["[done] First discussion", "[in-progress] Second discussion"] } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("[done] First discussion");
		expect(text).toContain("[in-progress] Second discussion");
		expect(text).not.toContain('"');
		expect(text).not.toContain("[\n");
	});

	it("bounds a large plain-string array to the default visible count and reports how many more remain", () => {
		const rows = Array.from({ length: 30 }, (_, i) => `row-${i}`);
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: rows } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("row-0");
		expect(text).not.toContain("row-29");
		expect(text).toContain("more");
	});

	it("shows every plain-string row with no truncation note when expanded is true", () => {
		const rows = Array.from({ length: 30 }, (_, i) => `row-${i}`);
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: rows } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("row-29");
		expect(text).not.toContain("more");
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
		// Two array fields deliberately -- singleArrayEnvelope only unwraps
		// exactly one, so this genuinely stays on the raw-JSON fallback path.
		const longOutput = {
			lines: Array.from({ length: 20 }, (_, i) => `line-${i}`),
			other: Array.from({ length: 5 }, (_, i) => i),
		};
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

	it("unwraps a single-array pagination envelope ({events, nextCursor}) and renders the inner array as a table", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{
				content: [],
				details: {
					output: {
						events: [
							{ id: "1", type: "focus_set" },
							{ id: "2", type: "status_changed" },
						],
						nextCursor: 42,
					},
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("focus_set");
		expect(text).toContain("status_changed");
		expect(text).toContain("nextCursor: 42");
	});

	it("unwraps a single-array envelope of plain strings too, annotating the sibling scalar", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { items: ["first", "second"], total: 2 } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("first");
		expect(text).toContain("second");
		expect(text).toContain("total: 2");
	});

	it("leaves an object with two array fields on the raw-JSON fallback -- too ambiguous to guess which array is the real payload", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { a: ["x"], b: ["y"] } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain('"a"');
	});

	it("leaves an object with a non-primitive sibling on the raw-JSON fallback", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { events: ["x"], meta: { nested: true } } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain('"meta"');
	});

	it("an envelope with an empty inner array falls through to raw JSON rather than a misleading 'No results.'", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { events: [], nextCursor: 1 } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain("events");
	});

	it("an envelope's unwrapped array still expands to show every row, with the sibling annotation preserved", () => {
		const rows = Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}` }));
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { events: rows, nextCursor: 7 } } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("row-29");
		expect(text).toContain("nextCursor: 7");
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
