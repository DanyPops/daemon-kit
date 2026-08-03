import { describe, expect, it } from "bun:test";
import { renderToTerminal, runMultiSelectViewportScenario } from "@danypops/pi-tui-harness";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createMultiSelectList } from "../src/multi-select-list.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

describe("createMultiSelectList", () => {
	it("binds Pi's semantic selection keymap to Malevich state", () => {
		const component = createMultiSelectList({
			items: [
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
			],
			theme,
			keybindings,
		});
		component.handleInput("\x1b[B");
		expect(component.model.focusedItem?.value).toBe("second");
		component.handleInput(" ");
		expect(component.checkedValues).toEqual(["second"]);
	});

	it("keeps Pi's tab and shift-tab navigation aliases", () => {
		const component = createMultiSelectList({
			items: [
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
			],
			theme,
			keybindings,
		});
		component.handleInput("\t");
		expect(component.model.focusedItem?.value).toBe("second");
		component.handleInput("\x1b[Z");
		expect(component.model.focusedItem?.value).toBe("first");
	});

	it("keeps cursor and checkbox semantics visible when theme colors collapse to plain text", () => {
		const component = createMultiSelectList({ items: [{ value: 1, label: "Topic" }], theme, keybindings });
		component.model.setChecked(0, true);
		expect(component.render(40)[0]).toContain("→ 1. [✓] Topic");
	});
});

const colorCodes: Record<string, number> = { accent: 36, success: 32, dim: 90, muted: 90, text: 37 };
const ansiTheme = {
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	fg: (color: string, text: string) => `\x1b[${colorCodes[color] ?? 37}m${text}\x1b[39m`,
};
const topics = [
	["Per-item output budgeting", "Truncate each oversized hit independently."],
	["Persisted-graph reliability", "Diagnose graph population, resume, and freshness."],
	["TypeScript call-hierarchy failure handling", "Surface tsserver failures as structured outcomes."],
	["Symbol and dataflow history", "Track symbol history without losing workspace identity."],
	["Cross-workspace symbol search", "Search several explicit projects with bounded output."],
	["Package-source cache lifecycle", "Keep fetched source bounded and removable."],
	["Workspace annotation freshness", "Detect stale symbol anchors before trusting them."],
] as const;

function triageList() {
	return createMultiSelectList({
		items: topics.map(([label, description], index) => ({ value: index + 1, label, description })),
		maxVisibleRows: 9,
		theme: ansiTheme,
		keybindings,
	});
}

async function plainFrame(rendered: readonly string[], width: number): Promise<string[]> {
	const terminal = await renderToTerminal(rendered, { cols: width, rows: rendered.length });
	try {
		return terminal.plainLines();
	} finally {
		terminal.dispose();
	}
}

describe("createMultiSelectList through pi-integral's real VT harness", () => {
	it("reproduces the four-topic flow: the fifth focus scrolls into view and remains selectable and deselectable", async () => {
		const frames = await runMultiSelectViewportScenario({ component: triageList(), width: 80 });
		expect(frames.initial.join("\n")).toContain("4. [ ] Symbol and dataflow history");
		expect(frames.initial.join("\n")).not.toContain("5. [ ] Cross-workspace symbol search");
		expect(frames.focusedBeyondViewport.join("\n")).toContain("→ 5. [ ] Cross-workspace symbol search");
		expect(frames.checked.join("\n")).toContain("→ 5. [✓] Cross-workspace symbol search");
		expect(frames.unchecked.join("\n")).toContain("→ 5. [ ] Cross-workspace symbol search");
		expect(frames.returnedToStart.join("\n")).toContain("→ 1. [ ] Per-item output budgeting");
	});

	it.each([40, 80, 120] as const)("keeps the focused fifth topic visible at %i columns", async (width) => {
		const list = triageList();
		list.focus(4);
		const lines = await plainFrame(list.render(width), width);
		expect(lines.join("\n")).toContain("→ 5. [ ] Cross-workspace symbol search");
	});

	it("preserves non-color focus and checked glyphs through a real VT parser", async () => {
		const list = triageList();
		list.model.setChecked(0, true);
		const lines = await plainFrame(list.render(80), 80);
		expect(lines[0]).toContain("→ 1. [✓] Per-item output budgeting");
	});
});
