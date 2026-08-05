import { describe, it } from "bun:test";
import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";
import { renderVehicleResult } from "../src/vehicle-render.ts";
import { assertFullBackgroundCoverage } from "./support/background-coverage.ts";

// A real Theme (truecolor, narrow resets only) -- matching vehicle-render.test.ts's own
// realTheme fixture. Fake tag-based themes elsewhere in this suite can never exercise a
// real background-coverage gap: they carry no actual ANSI bytes.
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

const REAL_BG_COLORS = {
	selectedBg: "#292929",
	userMessageBg: "#1f1f1f",
	customMessageBg: "#1b0d33",
	toolPendingBg: "#1f1f1f",
	toolSuccessBg: "#1d2b12",
	toolErrorBg: "#4c1405",
};

const realTheme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");
initTheme();

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function descriptor(effect: VehicleEffect): VehicleOperationDescriptor {
	return {
		name: "tasks.context",
		version: 1,
		description: "Reconciliation context.",
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		permissions: [],
		effect,
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
	};
}

function resultContext() {
	return { cwd: "/tmp", isError: false } as never;
}

/** Matches pi-mono's own tool-execution.ts wiring exactly: a Box(1, 1, bgFn) is the one
 * and only thing responsible for full-width background coverage of any child's output. */
function wrapInRealToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1, (text: string) => realTheme.bg("toolSuccessBg", text));
	box.addChild(component);
	return box.render(width);
}

describe("renderVehicleResult: full-width background coverage under the real tool Box (regression)", () => {
	it("covers every cell when a single-array envelope's sibling scalar is itself multi-line -- tasks.context's exact real shape", async () => {
		// The exact real output shape of Papyrus's tasks.context operation: a `content`
		// array (the one array field singleArrayEnvelope unwraps) alongside a `context`
		// sibling that is a real multi-paragraph string, not a short scalar like the
		// existing nextCursor/total sibling tests use.
		const output = {
			context:
				"Progress: 109/121 done\n" +
				"Next: rules_create/rules_update: return combined condition+action+body length\n\n" +
				"Reconcile before concluding or moving on:\n" +
				'\u2022 For each current task, ask: "Did we accomplish this task?"',
			content: [{ type: "text", text: "Progress: 109/121 done\nNext: rules_create/rules_update..." }],
		};
		const component = renderVehicleResult(
			descriptor("read"),
			{ content: [], details: { output } },
			{ isPartial: false, expanded: false },
			realTheme,
			resultContext(),
		);
		const boxed = wrapInRealToolBox(component, 100);
		await assertFullBackgroundCoverage(boxed, 100);
	});
});
