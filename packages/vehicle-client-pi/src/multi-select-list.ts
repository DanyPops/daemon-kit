import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { MultiSelectList, type MultiSelectListOptions } from "malevich-tui-components";

export interface MultiSelectHostTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface MultiSelectHostKeymap {
	matches(data: string, action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean;
}

export type CreateMultiSelectListOptions<T> = Omit<MultiSelectListOptions<T>, "theme" | "measure" | "matchesKey"> & {
	readonly theme: MultiSelectHostTheme;
	readonly keybindings: MultiSelectHostKeymap;
};

/** Binds Malevich's renderer-agnostic multi-select list to Pi's theme, text measurement, and user keymap. */
export function createMultiSelectList<T>(options: CreateMultiSelectListOptions<T>): MultiSelectList<T> {
	const { theme, keybindings, ...listOptions } = options;
	return new MultiSelectList({
		...listOptions,
		theme: {
			cursor: (text) => theme.fg("accent", text),
			checked: (text) => theme.fg("success", text),
			unchecked: (text) => theme.fg("dim", text),
			selectedLabel: (text) => theme.fg("accent", theme.bold(text)),
			label: (text) => theme.fg("text", theme.bold(text)),
			description: (text) => theme.fg("muted", text),
			status: (text) => theme.fg("dim", text),
		},
		measure: { visibleWidth, truncateToWidth, wrapTextWithAnsi },
		matchesKey: (data, keyId) => {
			if (keyId === "up")
				return keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.ctrl("k"));
			if (keyId === "down")
				return keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("j"));
			if (keyId === "enter") return keybindings.matches(data, "tui.select.confirm");
			if (keyId === "escape") return keybindings.matches(data, "tui.select.cancel");
			return matchesKey(data, keyId as Parameters<typeof matchesKey>[1]);
		},
	});
}

export type {
	MultiSelectConfirmAction,
	MultiSelectConfirmation,
	MultiSelectListItem,
	MultiSelectListOptions,
	MultiSelectListTheme,
} from "malevich-tui-components";
export { MultiSelectList } from "malevich-tui-components";
