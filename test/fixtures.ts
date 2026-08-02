import { createVehicleName, manifestHash, type ArmadaManifest, type VehicleRestartPolicy, type VehicleSpec } from "../src/index.js";

const DEFAULT_RESTART: VehicleRestartPolicy = { policy: "on-failure", delayMs: 1_000, maxAttempts: 3, windowMs: 60_000 };

export function vehicle(overrides: Partial<Omit<VehicleSpec, "name">> & { name?: string } = {}): VehicleSpec {
	const name = createVehicleName(overrides.name ?? "papyrus");
	if (!name.ok) throw new Error(name.reason);
	return Object.freeze({
		name: name.value,
		version: overrides.version ?? "1.0.0",
		executable: overrides.executable ?? "/opt/papyrus/cli.js",
		arguments: overrides.arguments ?? ["serve"],
		handlePath: overrides.handlePath ?? "/run/user/1000/papyrus/handle.json",
		restart: overrides.restart ?? DEFAULT_RESTART,
		readiness: overrides.readiness ?? { timeoutMs: 5_000, pollIntervalMs: 100 },
		...(overrides.workingDirectory === undefined ? {} : { workingDirectory: overrides.workingDirectory }),
		...(overrides.resources === undefined ? {} : { resources: overrides.resources }),
	});
}

export function manifest(vehicles: readonly VehicleSpec[] = [vehicle()]): ArmadaManifest {
	const content = { schemaVersion: 1 as const, vehicles };
	return Object.freeze({ ...content, contentHash: manifestHash(content) });
}

export function manifestJson(vehicles: unknown[] = [
	{
		name: "papyrus",
		version: "1.0.0",
		executable: "/opt/papyrus/cli.js",
		arguments: ["serve"],
		handlePath: "/run/user/1000/papyrus/handle.json",
		restart: { policy: "on-failure", delayMs: 1_000, maxAttempts: 3, windowMs: 60_000 },
		readiness: { timeoutMs: 5_000, pollIntervalMs: 100 },
	},
]): string {
	return JSON.stringify({ schemaVersion: 1, vehicles });
}
