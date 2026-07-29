import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Toggles a caller-owned subset of already-registered Pi tools active or
 * inactive, without ever touching a tool this caller doesn't own.
 *
 * `pi.setActiveTools()` replaces the WHOLE active set -- a naive "hide my
 * tool" call would silently disable every other extension's tools and the
 * user's own --tools flag along with it. This reads the current active set
 * first and only adds or removes names within `managedToolNames`, leaving
 * everything else exactly as it was.
 *
 * There is no `unregisterTool()` in Pi's extension API, so a tool that
 * becomes unavailable stays registered forever; this is the only real
 * mechanism to keep it out of the LLM's callable surface until it's
 * available again.
 *
 * Skips the `setActiveTools()` call entirely when the computed set is
 * identical to the current one, so a no-op refresh cycle (nothing changed)
 * doesn't churn Pi's own tool-list bookkeeping or logs.
 */
export function syncManagedActiveTools(
	pi: ExtensionAPI,
	managedToolNames: readonly string[],
	desiredActiveToolNames: readonly string[],
): void {
	const managed = new Set(managedToolNames);
	const desired = new Set(desiredActiveToolNames);
	for (const name of desired) {
		if (!managed.has(name)) {
			throw new Error(`syncManagedActiveTools: '${name}' is desired-active but not in managedToolNames`);
		}
	}

	const currentlyActive = pi.getActiveTools();
	const next = new Set(currentlyActive.filter((name) => !managed.has(name) || desired.has(name)));
	for (const name of desired) next.add(name);

	if (setsEqual(new Set(currentlyActive), next)) return;
	pi.setActiveTools([...next]);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}
