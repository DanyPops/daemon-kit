import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyHint, type Theme, type ThemeColor, type ToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	CollapsibleText,
	deriveTableColumns,
	firstDistinctStyle,
	ProgressBar,
	renderBoundedTable,
	renderTruncatedList,
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

/** A scalar value renders as itself; anything structured (array/object) falls back to compact JSON just for that one value, never for the whole args bag. */
function formatArgValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return JSON.stringify(value) ?? String(value);
}

/** Generic identity-ish argument key names, priority order. A domain with richer
 * semantics passes its own list to pickIdentityArgument instead. */
const DEFAULT_IDENTITY_ARG_KEYS = ["name", "title", "id", "text", "query", "url"] as const;

/** First present, non-empty string value from a priority-ordered key list. Exported so a
 * domain's own renderCall can reuse this instead of hand-rolling the same lookup. */
export function pickIdentityArgument(args: unknown, priorityKeys: readonly string[], maxLength = 80): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of priorityKeys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, maxLength);
	}
	return undefined;
}

/** Drops any arg whose value equals cwd -- e.g. a project_root identical to the session's
 * own working directory is noise once shown. */
function dropCwdRedundantArgs(args: Record<string, unknown>, cwd: string | undefined): Record<string, unknown> {
	if (cwd === undefined) return args;
	return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== cwd));
}

interface ArgsDisplay {
	/** One recognized identity value (see DEFAULT_IDENTITY_ARG_KEYS), styled distinctly from `rest`. */
	readonly identity?: string;
	/** Remaining args as `key=value key2=value2`; omits undefined values and whichever key became `identity`. */
	readonly rest?: string;
}

function splitArgsForDisplay(args: unknown, cwd: string | undefined, width: number): ArgsDisplay {
	if (args === undefined || args === null) return {};
	if (typeof args !== "object" || Array.isArray(args)) {
		const text = truncateToWidth(formatArgValue(args), width);
		return text ? { rest: text } : {};
	}
	const visible = dropCwdRedundantArgs(args as Record<string, unknown>, cwd);
	const identityKey = DEFAULT_IDENTITY_ARG_KEYS.find((key) => typeof visible[key] === "string" && (visible[key] as string).trim());
	const pairs = Object.entries(visible)
		.filter(([key, value]) => value !== undefined && key !== identityKey)
		.map(([key, value]) => `${key}=${formatArgValue(value)}`);
	return {
		identity: identityKey ? truncateToWidth(formatArgValue(visible[identityKey]), width) : undefined,
		rest: pairs.length ? truncateToWidth(pairs.join(" "), width) : undefined,
	};
}

export function renderVehicleCall(
	descriptor: VehicleOperationDescriptor,
	args: unknown,
	theme: Theme,
	context: RenderCallContext,
): Component {
	const { identity, rest } = splitArgsForDisplay(args, context.cwd, 60);
	const segments = [
		theme.bold(descriptor.name),
		...(identity ? [theme.fg("accent", identity)] : []),
		...(rest ? [theme.fg("dim", rest)] : []),
	];
	return new Text({ text: effectStyle(theme, descriptor.effect, segments.join(" ")), measure });
}

/** Rows beyond this default render as a truncation note (via Malevich's renderBoundedTable) instead of an ever-taller table -- a generic renderer has no schema-level sense of "how much of this array actually matters," so it borrows the same order-of-magnitude default several of Lector's own list renderers use (files/matches). Resolved here, at the Vehicle client, from Pi's own tool-row `expanded` flag -- the identical mechanism Lector's own renderers already key off, not a second, Vehicle-specific toggle. */
const DEFAULT_VISIBLE_ROWS = 20;

function moreRowsLine(theme: Theme, hiddenCount: number): string {
	return theme.fg("dim", `... ${hiddenCount} more row${hiddenCount === 1 ? "" : "s"} (${keyHint("app.tools.expand", "to expand")})`);
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

type Primitive = string | number | boolean | null | undefined;

function isPrimitive(value: unknown): value is Primitive {
	return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * A common REST/RPC pagination shape: one dominant array field plus a few
 * scalar siblings (a cursor, a count) -- e.g. {events, nextCursor}. Only
 * fires for exactly one non-empty array field with every sibling a
 * primitive; anything else (multiple array fields, a non-primitive
 * sibling) is ambiguous enough to leave alone rather than guess.
 */
function singleArrayEnvelope(output: unknown): { items: unknown[]; siblings: [string, Primitive][] } | undefined {
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	const entries = Object.entries(output as Record<string, unknown>);
	const arrayEntries = entries.filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]));
	if (arrayEntries.length !== 1) return undefined;
	const [arrayKey, items] = arrayEntries[0] as [string, unknown[]];
	if (items.length === 0) return undefined;
	const siblings = entries.filter(([key]) => key !== arrayKey);
	if (!siblings.every((entry): entry is [string, Primitive] => isPrimitive(entry[1]))) return undefined;
	return { items, siblings };
}

function formatSiblingLine(siblings: readonly [string, Primitive][]): string {
	return siblings.map(([key, value]) => `${key}: ${value === null || value === undefined ? "none" : String(value)}`).join(" · ");
}

/** Appends one more (already width-safe on its own render pass) line after an inner component's own output -- used to attach an envelope's sibling-field annotation without disturbing the inner component's own rendering. */
function withTrailingLine(inner: Component, line: string): Component {
	return {
		render: (width: number) => [...inner.render(width), truncateToWidth(line, width)],
		invalidate: () => inner.invalidate(),
	};
}

/** Renders an array the same way regardless of whether it arrived as the
 * top-level output or was unwrapped from a single-array envelope --
 * undefined when the array shape itself isn't one this renderer curates
 * (e.g. an array of numbers), signaling the caller to fall back to raw JSON. */
function renderArrayOutput(items: readonly unknown[], options: ToolRenderResultOptions, theme: Theme): Component | undefined {
	if (items.length === 0) return new Text({ text: theme.fg("dim", "No results."), measure });
	const table = deriveTableColumns(items);
	if (table) {
		return renderBoundedTable({
			...table,
			expanded: options.expanded,
			visibleRowCount: DEFAULT_VISIBLE_ROWS,
			moreLine: (hiddenCount) => moreRowsLine(theme, hiddenCount),
			headerStyle: (s) => theme.fg("muted", theme.bold(s)),
			measure,
		});
	}
	// deriveTableColumns only handles arrays of objects, returning undefined
	// for an array of plain strings (e.g. discuss.list's formatted summary
	// lines) -- without this, that shape fell through to a raw JSON.stringify
	// dump (quotes, brackets, commas, no color). Reuses the same bounded-list
	// primitive and "... N more" wording the table path already uses.
	if (items.every((item): item is string => typeof item === "string")) {
		const lines = renderTruncatedList({
			items,
			expanded: options.expanded,
			visibleCount: DEFAULT_VISIBLE_ROWS,
			formatItem: (item) => theme.fg("text", item),
			moreLine: (hiddenCount) => moreRowsLine(theme, hiddenCount),
		});
		return new Text({ text: lines.join("\n"), measure });
	}
	return undefined;
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
	if (Array.isArray(output)) {
		const rendered = renderArrayOutput(output, options, theme);
		if (rendered) return rendered;
	} else {
		const envelope = singleArrayEnvelope(output);
		if (envelope) {
			const rendered = renderArrayOutput(envelope.items, options, theme);
			if (rendered) {
				return envelope.siblings.length > 0 ? withTrailingLine(rendered, theme.fg("dim", formatSiblingLine(envelope.siblings))) : rendered;
			}
		}
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
