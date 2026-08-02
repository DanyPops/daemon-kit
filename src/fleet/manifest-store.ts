import { lstat, readFile } from "node:fs/promises";
import { diagnostic, type Diagnostic } from "./diagnostic.js";
import { createVehicleName } from "./identity.js";
import { decodeArmadaManifest, MAX_MANIFEST_BYTES, type ArmadaManifest, type VehicleSpec } from "./manifest.js";
import { replaceFileAtomically } from "../native/atomic-file.js";

export type ManifestMutationOutcome =
	| { readonly ok: true; readonly manifest: ArmadaManifest; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

async function readExisting(path: string): Promise<ManifestMutationOutcome> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
			return { ok: false, diagnostics: [diagnostic("MANIFEST_PATH_UNSAFE", "error", path, "manifest must be a bounded regular file")] };
		}
		const decoded = decodeArmadaManifest(await readFile(path, "utf8"));
		return decoded.ok ? { ...decoded, diagnostics: [] } : decoded;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			const decoded = decodeArmadaManifest('{"schemaVersion":1,"vehicles":[]}');
			return decoded.ok ? { ...decoded, diagnostics: [] } : decoded;
		}
		return { ok: false, diagnostics: [diagnostic("MANIFEST_READ_FAILED", "error", path, error instanceof Error ? error.message : String(error))] };
	}
}

function manifestText(vehicles: readonly VehicleSpec[]): string {
	return `${JSON.stringify({ schemaVersion: 1, vehicles }, null, 2)}\n`;
}

async function writeManifest(path: string, vehicles: readonly VehicleSpec[]): Promise<ManifestMutationOutcome> {
	const decoded = decodeArmadaManifest(manifestText(vehicles));
	if (!decoded.ok) return decoded;
	const written = await replaceFileAtomically(path, manifestText(decoded.manifest.vehicles));
	if (!written.ok) return written;
	return { ok: true, manifest: decoded.manifest, diagnostics: written.diagnostics };
}

export async function upsertManifestVehicle(path: string, vehicleJson: string): Promise<ManifestMutationOutcome> {
	let value: unknown;
	try {
		value = JSON.parse(vehicleJson);
	} catch (error) {
		return { ok: false, diagnostics: [diagnostic("MANIFEST_JSON_INVALID", "error", "/vehicle", error instanceof Error ? error.message : String(error))] };
	}
	const candidate = decodeArmadaManifest(JSON.stringify({ schemaVersion: 1, vehicles: [value] }));
	if (!candidate.ok) return candidate;
	const existing = await readExisting(path);
	if (!existing.ok) return existing;
	const next = [...existing.manifest.vehicles.filter((vehicle) => vehicle.name !== candidate.manifest.vehicles[0]!.name), candidate.manifest.vehicles[0]!];
	return writeManifest(path, next);
}

export async function removeManifestVehicle(path: string, name: string): Promise<ManifestMutationOutcome> {
	const vehicleName = createVehicleName(name);
	if (!vehicleName.ok) {
		return { ok: false, diagnostics: [diagnostic("MANIFEST_VEHICLE_NAME_INVALID", "error", "/vehicle", vehicleName.reason)] };
	}
	const existing = await readExisting(path);
	if (!existing.ok) return existing;
	return writeManifest(
		path,
		existing.manifest.vehicles.filter((vehicle) => vehicle.name !== vehicleName.value),
	);
}
