/**
 * Process-wide registry so several daemon-kit consumers (Enigma, pipes,
 * tickets, ...) can all contribute to one shared `/secrets` Pi command
 * instead of each needing its own distinctly-named command. Pi's own
 * registerCommand does not merge same-named registrations -- it keeps
 * every one and assigns numeric suffixes (`/secrets:1`, `/secrets:2`), see
 * extensions.md -- so the merge has to happen here, one level up.
 *
 * Different consumers can resolve to different *nested* copies of
 * daemon-kit (their own semver-pinned dependency range, hoisted or nested
 * independently by npm), so a plain module-level singleton in this file
 * would not be shared across them -- each copy would have its own map.
 * globalThis + Symbol.for() sidesteps that: it's keyed by name, not by
 * module identity, so every copy of this file, any version, reads and
 * writes the exact same underlying object.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SecretsBackend, ServicesRegistry } from "./secrets-backend.ts";

/**
 * An action appended to the merged [secrets] menu -- e.g. a vendor's own
 * login wizard, too specific for the generic SecretsBackend port to model.
 * Type-only import above, so this file carries no runtime dependency on
 * pi-coding-agent; structurally identical to secrets-tui.ts's own
 * SecretsMenuAction (same fields, same types) so values flow between the
 * two without a real (value-level) circular import between the files.
 */
export interface SecretsRegistryAction {
	value: string;
	label: string;
	description?: string;
	run: (ctx: ExtensionCommandContext) => Promise<void>;
}

export interface SecretsContribution {
	backends: SecretsBackend[];
	servicesRegistry?: ServicesRegistry;
	extraActions?: SecretsRegistryAction[];
}

export interface SecretsContributor {
	/** Stable per-consumer key, e.g. "enigma", "pipes", "tickets" -- registering again under the same key replaces the prior contributor instead of duplicating it, so a hot-reloaded extension doesn't accumulate stale copies of itself. */
	source: string;
	/** Called fresh on every /secrets invocation, so a contributor can rebuild its backends against current daemon/config state instead of a stale extension-load-time snapshot. */
	resolve: () => SecretsContribution | Promise<SecretsContribution>;
}

const REGISTRY_KEY = Symbol.for("@danypops/daemon-kit/secrets-registry@1");

interface SharedRegistryState {
	contributors: Map<string, SecretsContributor>;
	claimedCommandNames: Set<string>;
}

function sharedState(): SharedRegistryState {
	const g = globalThis as unknown as { [REGISTRY_KEY]?: SharedRegistryState };
	if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { contributors: new Map(), claimedCommandNames: new Set() };
	return g[REGISTRY_KEY];
}

export function registerSecretsContributor(contributor: SecretsContributor): void {
	sharedState().contributors.set(contributor.source, contributor);
}

/** Idempotent: removing an already-absent contributor is a no-op, not an error. */
export function unregisterSecretsContributor(source: string): void {
	sharedState().contributors.delete(source);
}

export function listSecretsContributors(): SecretsContributor[] {
	return Array.from(sharedState().contributors.values());
}

/**
 * Returns true exactly once per commandName across every daemon-kit copy
 * in this process -- the caller that gets `true` is the one that should
 * actually call pi.registerCommand(commandName, ...); every other caller
 * must skip that call and rely on its own registerSecretsContributor
 * instead, since a second registerCommand for the same name would not
 * merge with the first (see this file's header).
 */
export function claimSecretsCommandName(commandName: string): boolean {
	const state = sharedState();
	if (state.claimedCommandNames.has(commandName)) return false;
	state.claimedCommandNames.add(commandName);
	return true;
}

/** Test-only: resets both the contributor map and claimed-command-name set. Named distinctly (not "reset") so it can never be mistaken for production API. */
export function __resetSecretsRegistryForTests(): void {
	const state = sharedState();
	state.contributors.clear();
	state.claimedCommandNames.clear();
}
