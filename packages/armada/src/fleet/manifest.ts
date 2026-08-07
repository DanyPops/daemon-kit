import { isAbsolute, win32 } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { type Diagnostic, diagnostic } from "./diagnostic.js";
import { manifestHash } from "./hash.js";
import { createVehicleName, type ManifestHash, type VehicleName } from "./identity.js";

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_VEHICLES = 100;

const BoundedString = Type.String({ minLength: 1, maxLength: 4_096 });
const EnvironmentMap = Type.Record(Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" }), BoundedString, {
	maxProperties: 32,
	additionalProperties: false,
});
const Requirement = Type.Object(
	{
		value: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		enforcement: Type.Union([Type.Literal("required"), Type.Literal("optional")]),
	},
	{ additionalProperties: false },
);
const RestartPolicy = Type.Union([
	Type.Object({ policy: Type.Literal("never") }, { additionalProperties: false }),
	Type.Object(
		{
			policy: Type.Union([Type.Literal("always"), Type.Literal("on-failure")]),
			delayMs: Type.Integer({ minimum: 100, maximum: 3_600_000 }),
			maxAttempts: Type.Integer({ minimum: 1, maximum: 100 }),
			windowMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
		},
		{ additionalProperties: false },
	),
]);
const VehicleSchema = Type.Object(
	{
		name: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }),
		version: Type.String({ minLength: 1, maxLength: 128 }),
		executable: BoundedString,
		arguments: Type.Optional(Type.Array(BoundedString, { maxItems: 64 })),
		workingDirectory: Type.Optional(BoundedString),
		handlePath: BoundedString,
		env: Type.Optional(EnvironmentMap),
		restart: RestartPolicy,
		readiness: Type.Object(
			{
				timeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
				pollIntervalMs: Type.Integer({ minimum: 50, maximum: 30_000 }),
			},
			{ additionalProperties: false },
		),
		resources: Type.Optional(
			Type.Object(
				{
					maximumMemoryBytes: Type.Optional(Requirement),
					maximumCpuPercent: Type.Optional(Requirement),
					maximumTasks: Type.Optional(Requirement),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export const ArmadaManifestSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		vehicles: Type.Array(VehicleSchema, { maxItems: MAX_VEHICLES }),
	},
	{ additionalProperties: false },
);

const ManifestValidator = Compile(ArmadaManifestSchema);
type RawManifest = Static<typeof ArmadaManifestSchema>;
type RawVehicle = RawManifest["vehicles"][number];

export interface ResourceRequirement {
	readonly value: number;
	readonly enforcement: "required" | "optional";
}

export interface VehicleResources {
	readonly maximumMemoryBytes?: ResourceRequirement;
	readonly maximumCpuPercent?: ResourceRequirement;
	readonly maximumTasks?: ResourceRequirement;
}

export type VehicleRestartPolicy =
	| { readonly policy: "never" }
	| {
			readonly policy: "always" | "on-failure";
			readonly delayMs: number;
			readonly maxAttempts: number;
			readonly windowMs: number;
	  };

export interface VehicleSpec {
	readonly name: VehicleName;
	readonly version: string;
	readonly executable: string;
	readonly arguments: readonly string[];
	readonly workingDirectory?: string;
	readonly handlePath: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly restart: VehicleRestartPolicy;
	readonly readiness: {
		readonly timeoutMs: number;
		readonly pollIntervalMs: number;
	};
	readonly resources?: VehicleResources;
}

export interface ArmadaManifest {
	readonly schemaVersion: 1;
	readonly vehicles: readonly VehicleSpec[];
	readonly contentHash: ManifestHash;
}

export type ManifestDecodeOutcome =
	| { readonly ok: true; readonly manifest: ArmadaManifest }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const SECRET_MATERIAL =
	/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*\S+)/i;

function containsSecretMaterial(value: unknown): boolean {
	if (typeof value === "string") return SECRET_MATERIAL.test(value);
	if (Array.isArray(value)) return value.some(containsSecretMaterial);
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some(containsSecretMaterial);
}

function isAbsoluteOnAnyPlatform(path: string): boolean {
	return isAbsolute(path) || win32.isAbsolute(path);
}

function freeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze(child);
	return Object.freeze(value);
}

function toVehicle(raw: RawVehicle): VehicleSpec {
	const name = createVehicleName(raw.name);
	if (!name.ok) throw new Error(name.reason);
	return freeze({
		name: name.value,
		version: raw.version,
		executable: raw.executable,
		arguments: [...(raw.arguments ?? [])],
		...(raw.workingDirectory === undefined ? {} : { workingDirectory: raw.workingDirectory }),
		handlePath: raw.handlePath,
		...(raw.env === undefined ? {} : { env: { ...raw.env } }),
		restart: { ...raw.restart },
		readiness: { ...raw.readiness },
		...(raw.resources === undefined ? {} : { resources: { ...raw.resources } }),
	});
}

export function decodeArmadaManifest(text: string): ManifestDecodeOutcome {
	if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
		return { ok: false, diagnostics: [diagnostic("MANIFEST_TOO_LARGE", "error", "/", "manifest exceeds 1 MiB")] };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			diagnostics: [diagnostic("MANIFEST_JSON_INVALID", "error", "/", error instanceof Error ? error.message : String(error))],
		};
	}
	if (containsSecretMaterial(value)) {
		return { ok: false, diagnostics: [diagnostic("MANIFEST_SECRET_MATERIAL", "error", "/", "manifest contains secret-like material")] };
	}
	if (!ManifestValidator.Check(value)) {
		const first = ManifestValidator.Errors(value)[0];
		return {
			ok: false,
			diagnostics: [diagnostic("MANIFEST_SCHEMA_INVALID", "error", first?.instancePath || "/", first?.message ?? "invalid manifest")],
		};
	}
	const raw = value as RawManifest;
	const names = new Set<string>();
	const diagnostics: Diagnostic[] = [];
	for (const [index, vehicle] of raw.vehicles.entries()) {
		if (names.has(vehicle.name))
			diagnostics.push(diagnostic("MANIFEST_VEHICLE_DUPLICATE", "error", `/vehicles/${index}/name`, vehicle.name));
		names.add(vehicle.name);
		for (const [field, path] of [
			["executable", vehicle.executable],
			["handlePath", vehicle.handlePath],
			...(vehicle.workingDirectory === undefined ? [] : [["workingDirectory", vehicle.workingDirectory] as const]),
		] as const) {
			if (!isAbsoluteOnAnyPlatform(path)) {
				diagnostics.push(diagnostic("MANIFEST_PATH_NOT_ABSOLUTE", "error", `/vehicles/${index}/${field}`, path));
			}
		}
		if (vehicle.readiness.pollIntervalMs > vehicle.readiness.timeoutMs) {
			diagnostics.push(
				diagnostic("MANIFEST_READINESS_INTERVAL_INVALID", "error", `/vehicles/${index}/readiness`, "pollIntervalMs exceeds timeoutMs"),
			);
		}
	}
	if (diagnostics.length > 0) return { ok: false, diagnostics };
	const vehicles = raw.vehicles.map(toVehicle).sort((left, right) => left.name.localeCompare(right.name));
	const content = { schemaVersion: 1 as const, vehicles };
	return { ok: true, manifest: freeze({ ...content, contentHash: manifestHash(content) }) };
}
