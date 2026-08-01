/**
 * Wires the one status-refresh pattern every Vehicle-backed Pi extension
 * with a footer/widget ends up hand-rolling: refresh on session_start, and
 * refresh again whenever one of this extension's own projected tools just
 * ran (including an autonomous call the LLM makes mid-conversation, so a
 * human watching the footer and the model acting on the same state never
 * drift apart). A refresh failure (daemon not running, unreachable) is
 * swallowed -- a passive background repaint must never surprise-spawn a
 * daemon or surface an error for a widget nobody asked to see yet.
 *
 * Confirmed independently hand-copied at least three times before this
 * existed (pi-tickets, pi-papyrus, pi-jittor each pair their own
 * session_start/tool_execution_end handlers with their own tool-name-prefix
 * check and their own try/catch-and-ignore).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface VehicleStatusRefreshOptions {
	/** A tool name starting with any of these is "one of mine" -- refresh again after it runs. */
	readonly ownToolPrefixes: readonly string[];
	/** Does the real refresh (e.g. re-fetch focus state and call ctx.ui.setStatus). Thrown/rejected errors are swallowed. */
	readonly refresh: (ctx: ExtensionContext) => Promise<void> | void;
}

export function registerVehicleStatusRefresh(pi: ExtensionAPI, options: VehicleStatusRefreshOptions): void {
	async function safeRefresh(ctx: ExtensionContext): Promise<void> {
		try {
			await options.refresh(ctx);
		} catch {
			// Daemon down/unreachable, or the refresh itself failed -- leave
			// whatever status was last shown rather than surfacing this.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await safeRefresh(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!options.ownToolPrefixes.some((prefix) => event.toolName.startsWith(prefix))) return;
		await safeRefresh(ctx);
	});
}
