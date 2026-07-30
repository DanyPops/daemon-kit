import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOT_INITIALIZED_MARKER = "Extension runtime not initialized";

/**
 * pi.getAllTools()/getActiveTools()/setActiveTools() (Pi's "action methods")
 * throw a generic, uninformative "Extension runtime not initialized. Action
 * methods cannot be called during extension loading" when called directly
 * from an extension's own top-level factory body -- Pi only finishes
 * initializing the extension runtime after every extension's factory (and
 * its returned promise, if async) has resolved. This is a real, easy-to-hit
 * mistake: confirmed live, twice, independently -- two different Vehicle-
 * based Pi extensions each called registerVehicleTools() directly from their
 * top-level factory, and the resulting error was silently swallowed by each
 * extension's own daemon-unreachable try/catch, making every one of their
 * projected tools invisible to the model with zero visible sign why.
 *
 * Wraps any call to one of these methods so that specific failure becomes a
 * loud, actionable error instead of either a cryptic one-liner or (worse) a
 * silently swallowed exception several call-frames up.
 */
export function guardExtensionRuntimeInitialized<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof Error && error.message.includes(NOT_INITIALIZED_MARKER)) {
			throw new Error(
				"Called a Pi \"action method\" (getAllTools/getActiveTools/setActiveTools) before Pi's extension runtime finished initializing. " +
					'This happens when registerVehicleTools()/refreshVehicleToolAvailability() is called directly from an extension\'s top-level factory body -- call it from within a pi.on("session_start", ...) handler instead (or later), never from the factory body itself, even if the factory is async and awaited.',
				{ cause: error },
			);
		}
		throw error;
	}
}

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

	const currentlyActive = guardExtensionRuntimeInitialized(() => pi.getActiveTools());
	const next = new Set(currentlyActive.filter((name) => !managed.has(name) || desired.has(name)));
	for (const name of desired) next.add(name);

	if (setsEqual(new Set(currentlyActive), next)) return;
	guardExtensionRuntimeInitialized(() => pi.setActiveTools([...next]));
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}
