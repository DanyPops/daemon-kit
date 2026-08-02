import { diagnostic, type Diagnostic } from "./diagnostic.js";
import { manifestHash } from "./hash.js";
import type { VehicleName } from "./identity.js";
import type { ArmadaManifest } from "./manifest.js";
import type { NativeServiceState, NativeServiceStrategy } from "../native/service-manager.js";

const MAX_PROCESSES = 1_000;

export interface ObservedProcess {
	readonly pid: number;
	readonly executable: string;
	readonly command: string;
}

export interface ObservedVehicleHandle {
	readonly host: string;
	readonly port: number;
	readonly pid: number;
}

export interface FleetVehicleStatus {
	readonly name: VehicleName;
	readonly version: string;
	readonly executable: string;
	readonly nativeStatus: NativeServiceState["status"];
	readonly nativePid?: number;
	readonly handlePid?: number;
	readonly ready: boolean;
	readonly descriptorDrift: boolean;
	readonly matchingPids: readonly number[];
}

export interface FleetStatusReport {
	readonly vehicles: readonly FleetVehicleStatus[];
	readonly diagnostics: readonly Diagnostic[];
}

export interface FleetStatusInput {
	readonly manifest: ArmadaManifest;
	readonly nativeServices: readonly NativeServiceState[];
	readonly processes: readonly ObservedProcess[];
	readonly handles: ReadonlyMap<VehicleName, ObservedVehicleHandle>;
	readonly strategy: NativeServiceStrategy;
	readonly executableExists: (path: string) => boolean;
}

function matchingProcesses(executable: string, arguments_: readonly string[], processes: readonly ObservedProcess[]): readonly ObservedProcess[] {
	const argumentSignature = arguments_.join(" ");
	return processes.filter(
		(process) => process.executable === executable && (argumentSignature.length === 0 || process.command.includes(argumentSignature)),
	);
}

export function buildFleetStatus(input: FleetStatusInput): FleetStatusReport {
	if (input.processes.length > MAX_PROCESSES) {
		return {
			vehicles: [],
			diagnostics: [diagnostic("PROCESS_INVENTORY_TOO_LARGE", "error", "/processes", "process inventory exceeds 1000 entries")],
		};
	}
	const nativeByName = new Map(input.nativeServices.map((service) => [service.name, service]));
	const diagnostics: Diagnostic[] = [];
	const vehicles: FleetVehicleStatus[] = [];
	for (const vehicle of input.manifest.vehicles) {
		const native = nativeByName.get(vehicle.name) ?? { name: vehicle.name, status: "absent" as const };
		const handle = input.handles.get(vehicle.name);
		const matches = matchingProcesses(vehicle.executable, vehicle.arguments, input.processes);
		const descriptorDrift = native.specHash !== undefined && native.specHash !== manifestHash(vehicle);
		if (!input.executableExists(vehicle.executable)) {
			diagnostics.push(diagnostic("VEHICLE_EXECUTABLE_MISSING", "error", `/vehicles/${vehicle.name}/executable`, vehicle.executable));
		}
		if (descriptorDrift) {
			diagnostics.push(diagnostic("NATIVE_DESCRIPTOR_DRIFT", "error", `/vehicles/${vehicle.name}`, "native descriptor differs from desired state"));
		}
		if (native.status === "failed") {
			diagnostics.push(diagnostic("NATIVE_SERVICE_FAILED", "error", `/vehicles/${vehicle.name}`, "native service is failed or restart-exhausted"));
		}
		if (handle && (native.pid === undefined || handle.pid !== native.pid)) {
			diagnostics.push(diagnostic("VEHICLE_HANDLE_STALE", "warning", `/vehicles/${vehicle.name}/handle`, `handle references pid ${handle.pid}`));
		}
		if (matches.length > 1) {
			diagnostics.push(diagnostic("VEHICLE_PROCESS_DUPLICATE", "error", `/vehicles/${vehicle.name}/processes`, `${matches.length} matching processes`));
		}
		const unmanaged = matches.filter((process) => process.pid !== native.pid);
		if (unmanaged.length > 0) {
			diagnostics.push(
				diagnostic("VEHICLE_PROCESS_UNMANAGED", "warning", `/vehicles/${vehicle.name}/processes`, `unmanaged pids: ${unmanaged.map(({ pid }) => pid).join(",")}`),
			);
		}
		const generated = input.strategy.generateDescriptor(vehicle);
		diagnostics.push(...generated.diagnostics);
		vehicles.push(
			Object.freeze({
				name: vehicle.name,
				version: vehicle.version,
				executable: vehicle.executable,
				nativeStatus: native.status,
				...(native.pid === undefined ? {} : { nativePid: native.pid }),
				...(handle === undefined ? {} : { handlePid: handle.pid }),
				ready: native.status === "running" && native.pid !== undefined && handle?.pid === native.pid,
				descriptorDrift,
				matchingPids: Object.freeze(matches.map(({ pid }) => pid)),
			}),
		);
	}
	return { vehicles: Object.freeze(vehicles), diagnostics: Object.freeze(diagnostics) };
}
