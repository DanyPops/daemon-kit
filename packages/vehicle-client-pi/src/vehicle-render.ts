import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyHint, type Theme, type ThemeColor, type ToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	CollapsibleText,
	type DerivedTable,
	deriveTableColumns,
	firstDistinctStyle,
	ProgressBar,
	Table,
	Text,
	type TextMeasure,
} from "malevich-tui-components";

// ToolRenderContext itself isn't part of the public export barrel; derive
// its shape from the exported ToolDefinition so this stays in sync with
// whatever Pi actually passes, instead of hand-duplicating the interface.
type RenderCallContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type RenderResultContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/**
 * Generic default rendering for any Vehicle-projected Pi tool, driven by the
 * operation's own descriptor metadata (effect, name) rather than requiring
 * every operation to hand-roll renderCall/renderResult. A consumer with real
 * UX investment in one operation still supplies its own pair through
 * RegisterVehicleToolsOptions.renderers -- this is the fallback, not the
 * only option.
 */

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** Preference-ordered theme tokens per effect, most specific first -- cascaded through firstDistinctStyle since not every Pi theme defines all of these distinctly from plain text. */
const EFFECT_TOKENS: Record<VehicleEffect, readonly ThemeColor[]> = {
	read: ["muted", "dim"],
	"local-write": ["text"],
	"external-write": ["warning"],
	destructive: ["error"],
	"open-world": ["error"],
};

/** Absolute last-resort ANSI codes, used only when a theme fails to distinguish even its own error/warning tokens from plain text. */
const HARDCODED_FALLBACK: Record<VehicleEffect, string> = {
	read: "\x1b[90m", // bright black
	"local-write": "",
	"external-write": "\x1b[33m", // yellow
	destructive: "\x1b[31m", // red
	"open-world": "\x1b[31m",
};

function effectStyle(theme: Theme, effect: VehicleEffect, text: string): string {
	const baseline = theme.fg("text", text);
	const candidates = EFFECT_TOKENS[effect].map((token) => theme.fg(token, text));
	const fallbackCode = HARDCODED_FALLBACK[effect];
	const fallback = fallbackCode ? `${fallbackCode}${text}\x1b[39m` : text;
	return firstDistinctStyle(baseline, candidates, fallback);
}

function compactArgs(args: unknown, width: number): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "object" && !Array.isArray(args) && Object.keys(args as object).length === 0) return "";
	const json = JSON.stringify(args);
	return json === undefined ? "" : truncateToWidth(json, width);
}

export function renderVehicleCall(
	descriptor: VehicleOperationDescriptor,
	args: unknown,
	theme: Theme,
	context: RenderCallContext,
): Component {
	const argsText = compactArgs(args, Math.max(10, context.cwd ? 60 : 60));
	const line = argsText ? `${descriptor.name} ${theme.fg("dim", argsText)}` : descriptor.name;
	return new Text({ text: effectStyle(theme, descriptor.effect, line), measure });
}

/** Rows beyond this default render as a truncation note instead of an ever-taller table -- a generic renderer has no schema-level sense of "how much of this array actually matters," so it borrows the same order-of-magnitude default several of Lector's own list renderers use (files/matches). Resolved here, at the Vehicle client, from Pi's own tool-row `expanded` flag -- the identical mechanism Lector's own renderers already key off, not a second, Vehicle-specific toggle. */
const DEFAULT_VISIBLE_ROWS = 20;

/** A Table plus one appended, width-truncated footer line -- Malevich has no generic vertical-stack primitive, and this composition (one Table, one plain trailing note) is specific enough to Vehicle's generic row-bounding that it doesn't warrant becoming one yet. */
class TableWithFooter implements Component {
	constructor(
		private readonly table: Table,
		private readonly footerLine: string,
	) {}

	invalidate(): void {
		this.table.invalidate();
	}

	render(width: number): string[] {
		return [...this.table.render(width), truncateToWidth(this.footerLine, width)];
	}
}

/**
 * Bounds a derived table's rows to DEFAULT_VISIBLE_ROWS unless Pi's own
 * `expanded` flag says otherwise, appending a "... N more (expand)" note --
 * the same truncation shape Malevich's own renderTruncatedList codifies,
 * reimplemented directly here rather than called through it: that helper
 * produces formatted STRING lines one-for-one with its items, but Table
 * needs the real, unformatted row objects it wasn't truncated away from, so
 * there's no item-to-string mapping for it to usefully do here.
 */
function boundedTable(rows: Record<string, string>[], table: Omit<DerivedTable, "rows">, expanded: boolean, theme: Theme): Component {
	const displayCount = expanded ? rows.length : Math.min(DEFAULT_VISIBLE_ROWS, rows.length);
	const visibleRows = rows.slice(0, displayCount);
	const built = new Table({ ...table, rows: visibleRows, headerStyle: (s) => theme.fg("muted", theme.bold(s)), measure });
	const hiddenCount = rows.length - displayCount;
	if (hiddenCount <= 0) return built;
	const footer = theme.fg(
		"dim",
		`... ${hiddenCount} more row${hiddenCount === 1 ? "" : "s"} (${keyHint("app.tools.expand", "to expand")})`,
	);
	return new TableWithFooter(built, footer);
}

/** Best-effort duck-typing over an untyped Vehicle progress payload: {current,total} or {value,max} render as a bar, anything else falls back to a plain line. */
function progressBarFor(progress: unknown, theme: Theme): Component {
	if (progress && typeof progress === "object") {
		const p = progress as Record<string, unknown>;
		const value = typeof p.current === "number" ? p.current : typeof p.value === "number" ? p.value : undefined;
		const max = typeof p.total === "number" ? p.total : typeof p.max === "number" ? p.max : undefined;
		if (value !== undefined) {
			return new ProgressBar({ value, max: max ?? 100, style: (s) => theme.fg("accent", s), measure });
		}
	}
	const text = typeof progress === "string" ? progress : JSON.stringify(progress);
	return new Text({ text: theme.fg("dim", text ?? ""), measure });
}

export function renderVehicleResult(
	_descriptor: VehicleOperationDescriptor,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderResultContext,
): Component {
	const details = result.details as { output?: unknown; progress?: unknown } | undefined;

	if (options.isPartial) {
		return progressBarFor(details?.progress, theme);
	}

	if (context.isError) {
		const text = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
		return new CollapsibleText({
			text: theme.fg("error", text),
			collapsedLines: options.expanded ? Number.MAX_SAFE_INTEGER : 5,
			measure,
		});
	}

	const output = details?.output;
	if (Array.isArray(output) && output.length === 0) {
		return new Text({ text: theme.fg("dim", "No results."), measure });
	}
	const table = Array.isArray(output) ? deriveTableColumns(output) : undefined;
	if (table) {
		return boundedTable(table.rows, { columns: table.columns }, options.expanded, theme);
	}

	const text = JSON.stringify(output, null, 2) ?? "null";
	const collapsible = new CollapsibleText({
		text,
		collapsedLines: 5,
		headerStyle: (s) => theme.fg("dim", s),
		measure,
	});
	if (options.expanded) collapsible.expand();
	return collapsible;
}
