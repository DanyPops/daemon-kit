/**
 * Monolith Mode: bundles VehicleRegistry + LocalVehicleClient +
 * registerVehicleTools() into one call, for a Pi extension that wants its
 * own Vehicle-shaped tool projection (per-operation schemas, effect
 * classification, the generic renderer, /safety) without standing up a
 * daemon at all -- no HTTP, no port, no systemd unit, the provider and its
 * one consumer share a process.
 *
 * The equally-first-class alternative is the daemon+HTTP Split
 * (VehicleRegistry in a separate process, RemoteVehicleClient here) --
 * see the root README's "Split vs Monolith" section for when to pick which.
 */
import { LocalVehicleClient } from "@danypops/vehicle-client/local";
import type { VehicleManifestIdentity } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVehicleTools, type RegisterVehicleToolsOptions, type RegisteredPiVehicle } from "./vehicle-pi.js";

export interface MonolithVehicle {
	readonly registry: VehicleRegistry;
	readonly client: LocalVehicleClient;
	readonly tools: RegisteredPiVehicle;
}

/**
 * `identity` is the same `{name, version, description}` a VehicleRegistry
 * constructor already takes. `register` gets the fresh registry to call
 * `.register(owner, binding)` on -- the exact same operation-definition
 * shape a real daemon-backed provider uses, so a Monolith provider can be
 * upgraded to a real daemon later with zero change to its own operations.
 */
export async function createMonolithVehicle(
	pi: ExtensionAPI,
	identity: VehicleManifestIdentity,
	register: (registry: VehicleRegistry) => void,
	options: RegisterVehicleToolsOptions = {},
): Promise<MonolithVehicle> {
	const registry = new VehicleRegistry(identity);
	register(registry);
	const client = new LocalVehicleClient(registry);
	const tools = await registerVehicleTools(pi, client, options);
	return { registry, client, tools };
}
