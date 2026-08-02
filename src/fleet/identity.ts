export type VehicleName = string & { readonly __brand: "VehicleName" };
export type ManifestHash = string & { readonly __brand: "ManifestHash" };
export type PlanHash = string & { readonly __brand: "PlanHash" };

export type IdentityOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const VEHICLE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function createVehicleName(value: string): IdentityOutcome<VehicleName> {
	if (!VEHICLE_NAME.test(value)) return { ok: false, reason: "must match ^[a-z0-9][a-z0-9._-]{0,63}$" };
	return { ok: true, value: value as VehicleName };
}

export function createManifestHash(value: string): IdentityOutcome<ManifestHash> {
	if (!SHA256.test(value)) return { ok: false, reason: "must be a lowercase SHA-256 digest" };
	return { ok: true, value: value as ManifestHash };
}

export function createPlanHash(value: string): IdentityOutcome<PlanHash> {
	if (!SHA256.test(value)) return { ok: false, reason: "must be a lowercase SHA-256 digest" };
	return { ok: true, value: value as PlanHash };
}
