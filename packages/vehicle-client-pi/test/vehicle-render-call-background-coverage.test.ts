/**
 * Fresh live repro (screenshot, 2026-08-08): a tasks.create call's own rendered summary
 * line -- "Tasks Create <title>... body=## Context...") -- showed its painted background
 * ending mid-line, with the tail of the line (the body= argument) appearing to spill past
 * it into the terminal's own default background. Same class of symptom already tracked
 * for renderResult's partial->final streaming transition (vehicle task fc7fe3ce), now
 * checked here for renderCall specifically, isolating whether the gap is in
 * vehicle-client-pi's own component or entirely in Pi's own Box wrapper.
 */
import { describe, it } from "bun:test";
import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";
import { renderVehicleCall } from "../src/vehicle-render.ts";
import { assertFullBackgroundCoverage } from "./support/background-coverage.ts";

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
		name: "tasks.create",
		version: 1,
		description: "Creates a Task.",
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

function callContext() {
	return { cwd: "/home/dpopsuev/Projects/lector" } as never;
}

/** Matches pi-mono's own tool-execution.ts wiring exactly: a Box(1, 1, bgFn) is the one
 * and only thing responsible for full-width background coverage of any child's output. */
function wrapInRealToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1, (text: string) => realTheme.bg("toolPendingBg", text));
	box.addChild(component);
	return box.render(width);
}

const REAL_EPIC_BODY =
	"## Context\n\nLector hand-rolls its own `OperationName` union and a bespoke dispatch table instead of " +
	"reusing Vehicle's own operation-descriptor style (name/version/effect/permissions/limits, one real " +
	"handler per operation). This has drifted in practice: several operations declare their own ad-hoc " +
	"error shapes instead of Vehicle's typed failures, and every consumer re-derives its own tool " +
	"projection instead of reusing registerVehicleTools().\n\n## Scope\n\nMigrate Lector's dispatch table " +
	"onto real VehicleOperation descriptors one domain at a time, keeping the existing RPC wire shape " +
	"stable for every already-shipped client until the full migration lands.";

describe("renderVehicleCall: full-width background coverage under the real tool Box (regression)", () => {
	for (const width of [80, 100, 120, 140]) {
		it(`covers every cell of a tasks.create call's own line at width=${width}, title + long collapsed body`, async () => {
			const component = renderVehicleCall(
				descriptor("local-write"),
				{ title: "Epic: Migrate Lector's operation dispatch to Vehicle's operation-descriptor style", body: REAL_EPIC_BODY },
				realTheme,
				callContext(),
			);
			const boxed = wrapInRealToolBox(component, width);
			await assertFullBackgroundCoverage(boxed, width);
		});
	}
});
