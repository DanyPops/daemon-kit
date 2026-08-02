import type { NativeServiceState } from "../native/service-manager.js";
import { type Diagnostic, diagnostic } from "./diagnostic.js";
import { manifestHash, planHash } from "./hash.js";
import type { ManifestHash, PlanHash, VehicleName } from "./identity.js";
import type { ArmadaManifest, VehicleSpec } from "./manifest.js";

export type PlanOperation =
	| { readonly kind: "install"; readonly name: VehicleName; readonly specHash: ManifestHash }
	| { readonly kind: "update"; readonly name: VehicleName; readonly specHash: ManifestHash }
	| { readonly kind: "start" | "restart"; readonly name: VehicleName };

export interface FleetPlan {
	readonly manifestHash: ManifestHash;
	readonly planHash: PlanHash;
	readonly operations: readonly PlanOperation[];
	readonly diagnostics: readonly Diagnostic[];
}

export type PlanOutcome =
	| { readonly ok: true; readonly plan: FleetPlan }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

function vehicleSpecHash(vehicle: VehicleSpec): ManifestHash {
	return manifestHash(vehicle);
}

function operationFor(vehicle: VehicleSpec, actual: NativeServiceState | undefined): PlanOperation | undefined {
	const specHash = vehicleSpecHash(vehicle);
	if (!actual || actual.status === "absent") return { kind: "install", name: vehicle.name, specHash };
	if (actual.specHash !== specHash) return { kind: "update", name: vehicle.name, specHash };
	if (actual.status === "stopped") return { kind: "start", name: vehicle.name };
	if (actual.status === "failed") return { kind: "restart", name: vehicle.name };
	return undefined;
}

export function planFleet(manifest: ArmadaManifest, actualServices: readonly NativeServiceState[]): PlanOutcome {
	if (actualServices.length > 100) {
		return {
			ok: false,
			diagnostics: [diagnostic("ACTUAL_STATE_TOO_LARGE", "error", "/", "native manager returned more than 100 services")],
		};
	}
	const byName = new Map<VehicleName, NativeServiceState>();
	for (const service of actualServices) {
		if (byName.has(service.name)) {
			return {
				ok: false,
				diagnostics: [
					diagnostic("ACTUAL_STATE_DUPLICATE", "error", `/vehicles/${service.name}`, "native manager returned duplicate state"),
				],
			};
		}
		byName.set(service.name, service);
	}
	const operations = manifest.vehicles
		.map((vehicle) => operationFor(vehicle, byName.get(vehicle.name)))
		.filter((operation): operation is PlanOperation => operation !== undefined)
		.sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
	const content = { manifestHash: manifest.contentHash, operations, diagnostics: [] as Diagnostic[] };
	return { ok: true, plan: Object.freeze({ ...content, planHash: planHash(content) }) };
}
