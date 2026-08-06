/**
 * `/safety`: one place to see and control every registered Vehicle's
 * projected-tool policy state (allow/ask/blocked), instead of it being
 * scattered across each Vehicle's own registration-time options. Reads
 * from the shared vehicle-safety-registry contributors every
 * registerVehicleTools()/refreshVehicleToolAvailability() call already
 * populates unconditionally -- no extra wiring needed by any consumer
 * extension to show up here.
 *
 * Editing operates over the flat, unfiltered set of known operations
 * regardless of which of the three Tab-cycled views is currently open --
 * a deliberate scope reduction from a per-row-highlight edit affordance
 * (which would need Table to support row selection, which it doesn't):
 * 'e' closes the panel and runs two short ctx.ui.select() picks (which
 * operation, then which new state) instead of a custom
 * BorderedSelectPanel-driven list. Functionally identical outcome (an
 * override persists, a subsequent refresh honors it), far less code.
 *
 * Deliberately decomposed per this project's TUI-testing rule (Lexicon
 * practices/tui-testing.md): row-building, sorting, and view-shaping are
 * all pure functions, testable by asserting on their return value
 * directly -- the actual TabbedContainer/Table wiring below carries no
 * logic of its own worth testing beyond a thin smoke check.
 */
import type { VehicleEffect } from "@danypops/vehicle-core";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Envelope, type TabBarTheme, TabbedContainer, type TabbedContainerTab, Table, type TableColumn } from "malevich-tui-components";
import { VEHICLE_SAFETY_STATES, type VehicleSafetyPolicyStore, type VehicleSafetyState } from "./vehicle-safety.ts";
import {
	claimVehicleSafetyCommandName,
	listVehicleSafetyContributors,
	type VehicleSafetyContribution,
	type VehicleSafetyContributor,
} from "./vehicle-safety-registry.ts";

export interface VehicleSafetyRow {
	readonly tool: string;
	readonly command: string;
	readonly state: VehicleSafetyState;
	readonly vehicle: string;
	readonly effect: VehicleEffect;
}

/** The namespace prefix of a dotted operation name (e.g. "issues" from "issues.search"). Falls back to the whole name for an operation with no dot. */
export function toolNamespace(operationName: string): string {
	const dot = operationName.indexOf(".");
	return dot === -1 ? operationName : operationName.slice(0, dot);
}

/** A stable label identifying one row -- used to display and as the value an edit-flow ctx.ui.select() pick resolves back to a row. */
export function operationLabel(row: Pick<VehicleSafetyRow, "vehicle" | "command">): string {
	return `${row.vehicle}/${row.command}`;
}

export function buildVehicleSafetyRows(contributions: readonly VehicleSafetyContribution[]): VehicleSafetyRow[] {
	const rows: VehicleSafetyRow[] = [];
	for (const contribution of contributions) {
		for (const tool of contribution.tools) {
			rows.push({
				tool: toolNamespace(tool.operationName),
				command: tool.toolName,
				state: tool.state,
				vehicle: contribution.vehicleName,
				effect: tool.effect,
			});
		}
	}
	return rows;
}

export function findRowByLabel(rows: readonly VehicleSafetyRow[], label: string): VehicleSafetyRow | undefined {
	return rows.find((row) => operationLabel(row) === label);
}

/** Resolves a row's real operationName (not its projected toolName) so the policy store keys on the same identity registerVehicleTools() checks against. */
export function findOperationName(
	contributions: readonly VehicleSafetyContribution[],
	row: Pick<VehicleSafetyRow, "vehicle" | "command">,
): string {
	for (const contribution of contributions) {
		if (contribution.vehicleName !== row.vehicle) continue;
		const match = contribution.tools.find((tool) => tool.toolName === row.command);
		if (match) return match.operationName;
	}
	return row.command;
}

export type VehicleSafetySortKey = "namespace" | "vehicle" | "state";

const SORT_KEY_ORDER: readonly VehicleSafetySortKey[] = ["namespace", "vehicle", "state"];
const STATE_SORT_RANK: Record<VehicleSafetyState, number> = { blocked: 0, ask: 1, allow: 2 };

export function nextVehicleSafetySortKey(current: VehicleSafetySortKey): VehicleSafetySortKey {
	return SORT_KEY_ORDER[(SORT_KEY_ORDER.indexOf(current) + 1) % SORT_KEY_ORDER.length]!;
}

export function sortVehicleSafetyRows(rows: readonly VehicleSafetyRow[], sortKey: VehicleSafetySortKey): VehicleSafetyRow[] {
	const sorted = [...rows];
	sorted.sort((a, b) => {
		if (sortKey === "vehicle") return a.vehicle.localeCompare(b.vehicle) || a.tool.localeCompare(b.tool);
		if (sortKey === "state") return STATE_SORT_RANK[a.state] - STATE_SORT_RANK[b.state] || a.tool.localeCompare(b.tool);
		return a.tool.localeCompare(b.tool) || a.command.localeCompare(b.command);
	});
	return sorted;
}

export const ALL_VIEW_COLUMNS: readonly TableColumn[] = [
	{ header: "Tool", key: "tool" },
	{ header: "Command", key: "command" },
	{ header: "State", key: "state" },
	{ header: "Vehicle", key: "vehicle" },
	{ header: "Effect", key: "effect" },
];

export const ALLOWED_VIEW_COLUMNS: readonly TableColumn[] = [
	{ header: "Tool", key: "tool" },
	{ header: "Command", key: "command" },
	{ header: "Vehicle", key: "vehicle" },
	{ header: "Effect", key: "effect" },
];

export const BY_EFFECT_VIEW_COLUMNS: readonly TableColumn[] = [
	{ header: "Tool", key: "tool" },
	{ header: "Command", key: "command" },
	{ header: "Allowed", key: "allowed" },
];

export function buildAllViewTableRows(rows: readonly VehicleSafetyRow[]): Record<string, string>[] {
	return rows.map((row) => ({ tool: row.tool, command: row.command, state: row.state, vehicle: row.vehicle, effect: row.effect }));
}

/** Filtered to allow-state rows only -- the state column is dropped, redundant once every row is the same state. */
export function buildAllowedViewTableRows(rows: readonly VehicleSafetyRow[]): Record<string, string>[] {
	return rows
		.filter((row) => row.state === "allow")
		.map((row) => ({ tool: row.tool, command: row.command, vehicle: row.vehicle, effect: row.effect }));
}

/** One group per effect value, insertion-ordered by first appearance. "ask" and "blocked" both render as "no" -- this view only distinguishes "can run with no gate at all" from everything else. */
export function buildByEffectViewGroups(
	rows: readonly VehicleSafetyRow[],
): Array<{ effect: VehicleEffect; rows: Record<string, string>[] }> {
	const groups = new Map<VehicleEffect, Record<string, string>[]>();
	for (const row of rows) {
		const group = groups.get(row.effect) ?? [];
		group.push({ tool: row.tool, command: row.command, allowed: row.state === "allow" ? "yes" : "no" });
		groups.set(row.effect, group);
	}
	return [...groups.entries()].map(([effect, groupRows]) => ({ effect, rows: groupRows }));
}

function stateCellStyle(theme: Theme): (text: string, key: string) => string {
	return (text, key) => {
		if (key !== "state") return text;
		const trimmed = text.trim();
		if (trimmed === "allow") return theme.fg("success", text);
		if (trimmed === "ask") return theme.fg("warning", text);
		if (trimmed === "blocked") return theme.fg("error", text);
		return text;
	};
}

function allowedCellStyle(theme: Theme): (text: string, key: string) => string {
	return (text, key) => (key === "allowed" ? theme.fg(text.trim() === "yes" ? "success" : "error", text) : text);
}

/** A read-only Component wrapping a fixed set of pre-rendered lines -- every tab's content here, since none of the three views need their own input handling (Table has none of its own). */
class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

function tabBarTheme(theme: Theme): TabBarTheme {
	return {
		tab: (s) => theme.fg("dim", s),
		activeTab: (s) => theme.inverse(s),
		mnemonic: (s) => theme.underline(theme.bold(theme.fg("accent", s))),
	};
}

function buildTabs(rows: readonly VehicleSafetyRow[], theme: Theme): TabbedContainerTab[] {
	const allTable = new Table({ columns: [...ALL_VIEW_COLUMNS], rows: buildAllViewTableRows(rows), cellStyle: stateCellStyle(theme) });
	const allowedTable = new Table({ columns: [...ALLOWED_VIEW_COLUMNS], rows: buildAllowedViewTableRows(rows) });
	const byEffectLines: string[] = [];
	for (const group of buildByEffectViewGroups(rows)) {
		if (byEffectLines.length > 0) byEffectLines.push("");
		byEffectLines.push(theme.bold(theme.fg("accent", group.effect)));
		byEffectLines.push(
			...new Table({ columns: [...BY_EFFECT_VIEW_COLUMNS], rows: group.rows, cellStyle: allowedCellStyle(theme) }).render(200),
		);
	}
	return [
		{ key: "all", label: "All", content: new StaticLines(allTable.render(200)) },
		{ key: "allowed", label: "Allowed", content: new StaticLines(allowedTable.render(200)) },
		{ key: "by-effect", label: "By effect", content: new StaticLines(byEffectLines) },
	];
}

/**
 * Opens the panel; resolves "edit" if the human pressed 'e' (the panel
 * closes first, so the edit picks below run as their own top-level
 * dialogs, not nested inside this overlay), or undefined on Escape/close.
 */
async function showSafetyPanel(ctx: ExtensionCommandContext, rows: readonly VehicleSafetyRow[]): Promise<"edit" | undefined> {
	return ctx.ui.custom<"edit" | undefined>((tui, theme, _keybindings, done) => {
		// measure must be explicit: both Envelope and TabbedContainer default to
		// ASCII-only (raw .length, blind to ANSI escape codes), and this panel's tab
		// bar is styled through tabBarTheme's own theme.fg/theme.inverse/theme.bold --
		// without this, TabbedContainer truncates the styled bar by raw byte count,
		// landing mid-escape-sequence at a narrow render width.
		const measure = { visibleWidth, truncateToWidth };
		const envelope = new Envelope({ title: `Vehicle safety -- ${rows.length} operation(s)`, borderStyle: "rounded", measure });
		const tabbed = new TabbedContainer({ tabs: buildTabs(rows, theme), theme: tabBarTheme(theme), measure });
		envelope.setContent(tabbed);
		const helpLine = theme.fg("dim", "tab/shift-tab switch view \u2022 e edit an operation \u2022 esc close");
		return {
			render: (width: number) => [...envelope.render(width), helpLine],
			invalidate: () => envelope.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape")) {
					done(undefined);
					return;
				}
				if (data === "e") {
					done("edit");
					return;
				}
				tabbed.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export type PickOperationToEdit = (
	ctx: ExtensionCommandContext,
	rows: readonly VehicleSafetyRow[],
) => Promise<VehicleSafetyRow | undefined>;
export type PickNewState = (ctx: ExtensionCommandContext, row: VehicleSafetyRow) => Promise<VehicleSafetyState | undefined>;

async function defaultPickOperationToEdit(
	ctx: ExtensionCommandContext,
	rows: readonly VehicleSafetyRow[],
): Promise<VehicleSafetyRow | undefined> {
	const labels = rows.map((row) => operationLabel(row));
	const picked = await ctx.ui.select("Edit which operation?", labels);
	return picked ? findRowByLabel(rows, picked) : undefined;
}

async function defaultPickNewState(ctx: ExtensionCommandContext, row: VehicleSafetyRow): Promise<VehicleSafetyState | undefined> {
	const picked = await ctx.ui.select(`Set ${operationLabel(row)} to:`, [...VEHICLE_SAFETY_STATES]);
	return picked && (VEHICLE_SAFETY_STATES as readonly string[]).includes(picked) ? (picked as VehicleSafetyState) : undefined;
}

export interface RunVehicleSafetyCommandOptions {
	policyStore: VehicleSafetyPolicyStore;
	/** Overridden in tests instead of reaching the real process-wide registry. */
	contributors?: () => readonly VehicleSafetyContributor[];
	/** Overridden in tests instead of opening a real ctx.ui.custom overlay. */
	showPanel?: (ctx: ExtensionCommandContext, rows: readonly VehicleSafetyRow[]) => Promise<"edit" | undefined>;
	pickOperationToEdit?: PickOperationToEdit;
	pickNewState?: PickNewState;
}

/**
 * The full flow: resolves every contributor, and, when ctx.hasUI/ctx.mode
 * allow it, opens one Tab-cycled overlay -- reopened after every edit so
 * the human sees the effect immediately. A non-interactive caller
 * (ctx.mode !== "tui") gets a plain notify() summary instead, matching
 * secrets-tui.ts's own fallback for the same case.
 */
export async function runVehicleSafetyCommand(ctx: ExtensionCommandContext, options: RunVehicleSafetyCommandOptions): Promise<void> {
	const listContributors = options.contributors ?? listVehicleSafetyContributors;
	const showPanel = options.showPanel ?? showSafetyPanel;
	const pickOperationToEdit = options.pickOperationToEdit ?? defaultPickOperationToEdit;
	const pickNewState = options.pickNewState ?? defaultPickNewState;

	const contributors = listContributors();
	if (contributors.length === 0) {
		ctx.ui.notify("No Vehicle tools registered yet in this session.", "info");
		return;
	}

	for (;;) {
		const contributions = await Promise.all(contributors.map((c) => c.resolve()));
		const rows = sortVehicleSafetyRows(buildVehicleSafetyRows(contributions), "namespace");

		if (ctx.mode !== "tui") {
			const summary = rows.map((row) => `${operationLabel(row)}: ${row.state}`).join(", ");
			ctx.ui.notify(`Vehicle safety (${rows.length} operations): ${summary || "(none)"}`, "info");
			return;
		}

		const result = await showPanel(ctx, rows);
		if (result !== "edit") return;

		const row = await pickOperationToEdit(ctx, rows);
		if (!row) continue;
		const nextState = await pickNewState(ctx, row);
		if (!nextState) continue;
		await options.policyStore.set(row.vehicle, findOperationName(contributions, row), nextState);
		ctx.ui.notify(`${operationLabel(row)} set to ${nextState}. Effective on the next refresh.`, "info");
	}
}

/**
 * Registers `/safety` once per process -- every other vehicle-client-pi
 * copy in the session just contributes via the shared registry instead of
 * calling this a second time (see claimVehicleSafetyCommandName).
 */
export function registerVehicleSafetyCommand(pi: ExtensionAPI, policyStore: VehicleSafetyPolicyStore, commandName = "safety"): void {
	if (!claimVehicleSafetyCommandName(commandName)) return;
	pi.registerCommand(commandName, {
		description: "View and control every registered Vehicle's tool policy (allow/ask/blocked) in one place",
		handler: async (_args, ctx) => runVehicleSafetyCommand(ctx, { policyStore }),
	});
}
