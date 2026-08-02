/**
 * Process-wide registry so `/safety` sees every Vehicle a session has
 * registered, not just the one belonging to whichever extension happens to
 * register the command -- the same globalThis + Symbol.for() sharing
 * secrets-registry.ts already established, for the same reason: several
 * nested copies of vehicle-client-pi (different semver-pinned dependency
 * ranges, hoisted or nested independently) must still share one registry.
 *
 * registerVehicleTools/refreshVehicleToolAvailability (vehicle-pi.ts)
 * contribute here unconditionally, with no option flag -- the same
 * "opt-in by construction" convention the Activity Broker uses: an
 * extension that never registers the `/safety` command pays only the cost
 * of one Map entry per registered Vehicle, never a behavior change.
 */
import type { VehicleEffect } from "@danypops/vehicle-core";
import type { VehicleSafetyState } from "./vehicle-safety.ts";

export interface VehicleSafetyToolEntry {
	readonly toolName: string;
	readonly operationName: string;
	readonly effect: VehicleEffect;
	readonly state: VehicleSafetyState;
}

export interface VehicleSafetyContribution {
	readonly vehicleName: string;
	readonly tools: readonly VehicleSafetyToolEntry[];
}

export interface VehicleSafetyContributor {
	/** Stable per-Vehicle key (the manifest name) -- registering again under the same key replaces the prior contributor instead of duplicating it, so a refresh cycle doesn't accumulate stale copies of itself. */
	source: string;
	/** Called fresh on every /safety invocation, so the command always reflects the Vehicle's current registration state instead of a stale snapshot. */
	resolve: () => VehicleSafetyContribution | Promise<VehicleSafetyContribution>;
}

const REGISTRY_KEY = Symbol.for("@danypops/vehicle-client-pi/safety-registry@1");

interface SharedRegistryState {
	contributors: Map<string, VehicleSafetyContributor>;
	claimedCommandNames: Set<string>;
}

function sharedState(): SharedRegistryState {
	const g = globalThis as unknown as { [REGISTRY_KEY]?: SharedRegistryState };
	if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { contributors: new Map(), claimedCommandNames: new Set() };
	return g[REGISTRY_KEY];
}

export function registerVehicleSafetyContributor(contributor: VehicleSafetyContributor): void {
	sharedState().contributors.set(contributor.source, contributor);
}

/** Idempotent: removing an already-absent contributor is a no-op, not an error. */
export function unregisterVehicleSafetyContributor(source: string): void {
	sharedState().contributors.delete(source);
}

export function listVehicleSafetyContributors(): VehicleSafetyContributor[] {
	return Array.from(sharedState().contributors.values());
}

/**
 * Returns true exactly once per commandName across every vehicle-client-pi
 * copy in this process -- the caller that gets `true` is the one that
 * should actually call pi.registerCommand(commandName, ...); every other
 * caller relies on its contributed state showing up in the shared command
 * instead of registering a second, colliding command of its own.
 */
export function claimVehicleSafetyCommandName(commandName: string): boolean {
	const state = sharedState();
	if (state.claimedCommandNames.has(commandName)) return false;
	state.claimedCommandNames.add(commandName);
	return true;
}

/** Test-only: resets both the contributor map and claimed-command-name set. Named distinctly (not "reset") so it can never be mistaken for production API. */
export function __resetVehicleSafetyRegistryForTests(): void {
	const state = sharedState();
	state.contributors.clear();
	state.claimedCommandNames.clear();
}
