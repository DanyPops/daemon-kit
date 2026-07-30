import type { Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CollapsibleText, ProgressBar, Table, type TableColumn, type TextMeasure } from "malevich-tui-components";
import type { VehicleEffect, VehicleOperationDescriptor } from "@danypops/vehicle-core";

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

function effectColor(effect: VehicleEffect): "muted" | "text" | "warning" | "error" {
	switch (effect) {
		case "read":
			return "muted";
		case "local-write":
			return "text";
		case "external-write":
			return "warning";
		case "destructive":
		case "open-world":
			return "error";
	}
}

/** A single pre-rendered line, wrapped as a Component -- for the cases where a plain styled line is all that's needed and reaching for a Malevich widget would be overkill. */
class TextLine implements Component {
	constructor(private readonly line: string) {}
	invalidate(): void {}
	render(width: number): string[] {
		return [truncateToWidth(this.line, width)];
	}
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
	const color = effectColor(descriptor.effect);
	const argsText = compactArgs(args, Math.max(10, context.cwd ? 60 : 60));
	const line = argsText ? `${descriptor.name} ${theme.fg("dim", argsText)}` : descriptor.name;
	return new TextLine(theme.fg(color, line));
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
	return new TextLine(theme.fg("dim", text ?? ""));
}

/** An array of plain objects (not arrays/primitives) with at least one entry renders as a Table; anything else isn't table-shaped. */
function asTableRows(output: unknown): { columns: TableColumn[]; rows: Record<string, string>[] } | undefined {
	if (!Array.isArray(output) || output.length === 0) return undefined;
	if (!output.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) return undefined;
	const keys = new Set<string>();
	for (const item of output as Record<string, unknown>[]) {
		for (const key of Object.keys(item)) keys.add(key);
	}
	const columns: TableColumn[] = [...keys].map((key) => ({ header: key, key }));
	const rows = (output as Record<string, unknown>[]).map((item) => {
		const row: Record<string, string> = {};
		for (const key of keys) {
			const value = item[key];
			row[key] = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
		}
		return row;
	});
	return { columns, rows };
}

export function renderVehicleResult(
	descriptor: VehicleOperationDescriptor,
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
	const table = asTableRows(output);
	if (table) {
		return new Table({
			...table,
			headerStyle: (s) => theme.fg("muted", theme.bold(s)),
			measure,
		});
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
