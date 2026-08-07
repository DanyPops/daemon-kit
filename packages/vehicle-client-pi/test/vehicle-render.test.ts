import { describe, expect, it } from "bun:test";
import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { humanizeOperationName, pickIdentityArgument, renderVehicleCall, renderVehicleResult } from "../src/vehicle-render.ts";

// A real Theme, not a fake -- fg()/bg() throw for a token missing here, unlike fakeTheme/flatTheme/ansiTheme.
const REAL_FG_COLORS: Record<ThemeColor, string> = {
	accent: "#ee0000",
	border: "#4d4d4d",
	borderAccent: "#ee0000",
	borderMuted: "#383838",
	success: "#6c9b4b",
	error: "#bd6e51",
	warning: "#dca614",
	muted: "#8f8f8f",
	dim: "#757575",
	text: "#e0e0e0",
	thinkingText: "#8f8f8f",
	userMessageText: "#e0e0e0",
	customMessageText: "#e0e0e0",
	customMessageLabel: "#876fd4",
	toolTitle: "#d39292",
	toolOutput: "#e0e0e0",
	mdHeading: "#e0e0e0",
	mdLink: "#0066cc",
	mdLinkUrl: "#0066cc",
	mdCode: "#e0e0e0",
	mdCodeBlock: "#e0e0e0",
	mdCodeBlockBorder: "#383838",
	mdQuote: "#8f8f8f",
	mdQuoteBorder: "#383838",
	mdHr: "#383838",
	mdListBullet: "#e0e0e0",
	toolDiffAdded: "#6c9b4b",
	toolDiffRemoved: "#bd6e51",
	toolDiffContext: "#8f8f8f",
	syntaxComment: "#8f8f8f",
	syntaxKeyword: "#876fd4",
	syntaxFunction: "#63bdbd",
	syntaxVariable: "#e0e0e0",
	syntaxString: "#6c9b4b",
	syntaxNumber: "#dca614",
	syntaxType: "#63bdbd",
	syntaxOperator: "#e0e0e0",
	syntaxPunctuation: "#e0e0e0",
	thinkingOff: "#8f8f8f",
	thinkingMinimal: "#8f8f8f",
	thinkingLow: "#8f8f8f",
	thinkingMedium: "#8f8f8f",
	thinkingHigh: "#8f8f8f",
	thinkingXhigh: "#8f8f8f",
	thinkingMax: "#8f8f8f",
	bashMode: "#e0e0e0",
};

// ThemeBg isn't exported from the top-level barrel; inferred instead of annotated.
const REAL_BG_COLORS = {
	selectedBg: "#292929",
	userMessageBg: "#1f1f1f",
	customMessageBg: "#1b0d33",
	toolPendingBg: "#1f1f1f",
	toolSuccessBg: "#1d2b12",
	toolErrorBg: "#4c1405",
};

const realTheme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");

// A theme that emits real ANSI SGR escape codes (truecolor, like a real theme's
// fg() output), not the plain "<color>text" markers fakeTheme/flatTheme use --
// those can never exercise an ANSI-blind width miscalculation, since they carry
// no actual escape bytes for a naive .length-based measure to miscount.
const ansiTheme = {
	fg: (color: string, text: string) => (color === "error" ? `\x1b[38;2;212;114;138m${text}\x1b[39m` : text),
	bold: (text: string) => text,
} as unknown as Theme;

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
	it("includes the operation name and compact args as key=value pairs, not raw JSON", () => {
		const component = renderVehicleCall(descriptor("read"), { backend: "github" }, fakeTheme, callContext());
		const line = component.render(80).join("\n");
		expect(line).toContain("Issue List");
		expect(line).toContain("backend=github");
		expect(line).not.toContain("{");
		expect(line).not.toContain('"');
	});

	it("joins several args with spaces, skipping undefined values", () => {
		const component = renderVehicleCall(descriptor("read"), { backend: "github", limit: 5, missing: undefined }, fakeTheme, callContext());
		const line = component.render(80).join("\n");
		expect(line).toContain("backend=github limit=5");
		expect(line).not.toContain("missing");
	});

	it("renders the operation name bold, matching a real Tool Command title", () => {
		const boldTheme = { ...fakeTheme, bold: (text: string) => `[b]${text}[/b]` } as unknown as Theme;
		const component = renderVehicleCall(descriptor("read"), {}, boldTheme, callContext());
		expect(component.render(80)[0]).toContain("[b]Issue List[/b]");
	});

	it("omits the args snippet for an empty-object call", () => {
		const component = renderVehicleCall(descriptor("read"), {}, fakeTheme, callContext());
		expect(component.render(80)).toEqual(["<muted>Issue List"]);
	});

	// Applies when the theme never distinguishes any candidate token from plain text.
	it("falls back to a hardcoded ANSI color", () => {
		const component = renderVehicleCall(descriptor("destructive"), {}, flatTheme, callContext());
		expect(component.render(80)[0]).toContain("\x1b[31m");
	});

	it("drops an arg whose value equals context.cwd, e.g. a redundant project_root", () => {
		const component = renderVehicleCall(
			descriptor("read"),
			{ project_root: "/tmp", status: "review" },
			fakeTheme,
			callContext({ cwd: "/tmp" }),
		);
		const line = component.render(80).join("\n");
		expect(line).not.toContain("project_root");
		expect(line).not.toContain("/tmp");
		expect(line).toContain("status=review");
	});

	// tasks.create's real shape: a title plus a full markdown body -- previously leaked the
	// body's embedded newlines straight into what's meant to be a one-line call summary,
	// producing extra orphaned physical lines (confirmed live).
	it("collapses embedded newlines in an arg value instead of leaking extra physical lines", () => {
		const component = renderVehicleCall(
			descriptor("local-write"),
			{ title: "Lector: enforce Biome noImportCycles", body: "## Context\n\nThe repo's already-configured rule." },
			fakeTheme,
			callContext(),
		);
		const lines = component.render(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\n");
	});

	// Never buried in key=value order.
	it("surfaces a recognized identity arg (id/name/title/...) plainly and first", () => {
		const component = renderVehicleCall(descriptor("read"), { status: "review", id: "abc-123" }, fakeTheme, callContext());
		const line = component.render(80).join("\n");
		expect(line).not.toContain("id=abc-123");
		expect(line.indexOf("<accent>abc-123")).toBeGreaterThan(-1);
		expect(line.indexOf("<dim>status=review")).toBeGreaterThan(line.indexOf("<accent>abc-123"));
	});

	it("combines cwd-suppression and identity-arg promotion together", () => {
		const component = renderVehicleCall(
			descriptor("read"),
			{ project_root: "/tmp", id: "abc-123" },
			fakeTheme,
			callContext({ cwd: "/tmp" }),
		);
		expect(component.render(80).join("\n")).toBe("<muted>Issue List <accent>abc-123");
	});
});

// Drives renderVehicleCall through the real Theme across every effect/arg shape --
// asserts it never throws, unlike a fake theme that accepts any color string.
describe("renderVehicleCall against the real Theme class (golden)", () => {
	const effects: VehicleEffect[] = ["read", "local-write", "external-write", "destructive", "open-world"];
	const argShapes: Record<string, unknown> = {
		empty: {},
		undefinedArgs: undefined,
		identityOnly: { id: "abc-123" },
		identityPlusRest: { id: "abc-123", status: "review", limit: 5 },
		cwdRedundant: { project_root: "/tmp", id: "abc-123" },
		noIdentity: { backend: "github", limit: 5 },
	};

	for (const effect of effects) {
		for (const [shapeName, args] of Object.entries(argShapes)) {
			it(`renders effect=${effect} args=${shapeName} without throwing, producing a non-empty line`, () => {
				const component = renderVehicleCall(descriptor(effect), args, realTheme, callContext({ cwd: "/tmp" }));
				const line = component.render(80).join("\n");
				expect(line.length).toBeGreaterThan(0);
				expect(line).toContain("Issue List");
			});
		}
	}
});

describe("humanizeOperationName", () => {
	it("title-cases a dotted domain.action operation name", () => {
		expect(humanizeOperationName("tasks.show")).toBe("Tasks Show");
	});

	it("splits snake_case within a segment into separate title-cased words", () => {
		expect(humanizeOperationName("tasks.cancel_subtree")).toBe("Tasks Cancel Subtree");
	});

	it("handles a single-segment, single-word name", () => {
		expect(humanizeOperationName("backends_list")).toBe("Backends List");
	});
});

describe("pickIdentityArgument", () => {
	it("returns the first present, non-empty string value from a priority-ordered key list", () => {
		expect(pickIdentityArgument({ status: "open", title: "Fix the bug" }, ["name", "title", "id"])).toBe("Fix the bug");
	});

	it("skips a blank or non-string candidate and keeps looking", () => {
		expect(pickIdentityArgument({ name: "   ", id: 42, title: "Real title" }, ["name", "id", "title"])).toBe("Real title");
	});

	it("returns undefined when nothing in the priority list matches", () => {
		expect(pickIdentityArgument({ backend: "github" }, ["name", "title", "id"])).toBeUndefined();
	});

	it("returns undefined for non-object args instead of throwing", () => {
		expect(pickIdentityArgument(undefined, ["name"])).toBeUndefined();
		expect(pickIdentityArgument(["a", "b"], ["name"])).toBeUndefined();
	});

	it("truncates to the given max length", () => {
		expect(pickIdentityArgument({ name: "a".repeat(100) }, ["name"], 10)).toBe("a".repeat(10));
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

	// Reports how many more rows remain, using Pi's own expanded flag.
	it("bounds a large array output to the default visible row count", () => {
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

	it("bounds a large plain-string array to the default visible count", () => {
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

	// The exact shape reported live: tasks.claim's TaskLease, previously dumped as raw JSON
	// because it has no array field for singleArrayEnvelope/plainContentEnvelope to unwrap.
	it("renders a flat all-primitive object as an aligned field list, not raw JSON", () => {
		const component = renderVehicleResult(
			descriptor("local-write"),
			{
				content: [],
				details: {
					output: {
						taskId: "56ab35b0-bc38-4b29-86ff-0561a0dc91a3",
						owner: "019fd235-1941-7835-adcd-c42598576c5a",
						token: "e52220fa-a577-4d10-8832-c051db78b438",
						claimedAt: "2026-08-06T20:52:43.566Z",
					},
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Task Id");
		expect(text).toContain("56ab35b0-bc38-4b29-86ff-0561a0dc91a3");
		expect(text).toContain("Owner");
		expect(text).toContain("Claimed At");
		expect(text).not.toContain("{");
		expect(text).not.toContain('"');
	});

	// Matches formatSiblingLine's own convention.
	it("renders null/undefined fields in a flat record as 'none'", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { note: null, count: 3, active: true } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Note:");
		expect(text).toContain("none");
		expect(text).toContain("Count:");
		expect(text).toContain("3");
		expect(text).toContain("Active:");
		expect(text).toContain("true");
	});

	// A flat record is a narrower shape than "any object".
	it("still falls back to raw JSON for an object with a nested object field", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { nested: { a: 1 } } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain('"a": 1');
	});

	it("still falls back to raw JSON for an empty object", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: {} } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toBe("{}");
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

	it("unwraps a single-array pagination envelope ({events, nextCursor}) as a table", () => {
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

	// Too ambiguous to guess which array is the real payload.
	it("leaves an object with two array fields on the raw-JSON fallback", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { a: ["x"], b: ["y"] } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain('"a"');
	});

	it("unwraps a single domain array alongside a VehicleContentBlock[] content sibling", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{
				content: [],
				details: {
					output: { items: ["first", "second"], content: [{ type: "text", text: "Listed 2 items" }] },
				},
			},
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("first");
		expect(text).toContain("second");
		// The raw-JSON fallback would print the content sibling's own {"type":"text",...}
		// block verbatim -- absent here proves this actually unwrapped as a bulleted list,
		// not merely that "first"/"second" happen to appear somewhere in an un-expanded dump.
		expect(text).not.toContain("{");
		expect(text).not.toContain('"type"');
	});

	// content exclusion isn't newly permissive for real ambiguity.
	it("still falls back to raw JSON for two GENUINE domain arrays plus a content sibling", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{
				content: [],
				details: { output: { a: ["x"], b: ["y"], content: [{ type: "text", text: "note" }] } },
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain('"a"');
	});

	// The exact real shape of Papyrus's discuss.block/unblock: {blocked: true, content: [...]}.
	// singleArrayEnvelope correctly excludes `content` from ever being treated as domain array
	// data (484f14c) -- but that leaves genuinely zero array fields here, so this must fall
	// through to a content-aware plain-text rendering instead of a raw JSON dump, the same way
	// the model's own content channel (extractVehicleContent) already reads this shape.
	it("a content-only envelope with no domain array shows its own narration, not raw JSON", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { blocked: true, content: [{ type: "text", text: 'Discussion "X" now blocks "Y"' }] } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("now blocks");
		expect(text).not.toContain("{");
	});

	// Same as a domain-array envelope does.
	it("a content-only envelope still annotates its other primitive siblings", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { blocked: true, content: [{ type: "text", text: "done" }] } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("blocked: true");
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

	// Never a misleading "No results."
	it("an envelope with an empty inner array falls through to raw JSON", () => {
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output: { events: [], nextCursor: 1 } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain("events");
	});

	// The sibling annotation is preserved through the expansion.
	it("an envelope's unwrapped array still expands to show every row", () => {
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

	// Regression guard for a real reported symptom: an error result's background box
	// visibly cut short of the terminal's own width, unlike the call line above it --
	// exactly the "ANSI-blind default measure" bug class malevich-tui-components has
	// already hit in Table and Envelope (real ANSI escape bytes counted as visible
	// characters, undercounting the padding a styled line needs). Wraps the error
	// Component in a real pi-tui Box with a background function, mirroring Pi's own
	// tool-execution.ts (both the call and result renderers share one Box/one width).
	it("pads an ANSI-styled error result to the full box width, matching every other line", () => {
		const longMessage = "vehicle-client-failed: Vehicle operation deadline exceeded";
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [{ type: "text", text: longMessage }], details: {} },
			{ isPartial: false, expanded: false },
			ansiTheme,
			resultContext({ isError: true }),
		);
		const box = new Box(1, 1, (text) => `\x1b[41m${text}\x1b[49m`);
		box.addChild(component);
		const lines = box.render(80);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});
});
