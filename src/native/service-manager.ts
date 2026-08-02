import type { Diagnostic } from "../fleet/diagnostic.js";
import type { VehicleName } from "../fleet/identity.js";
import type { VehicleSpec } from "../fleet/manifest.js";

export type NativeManagerKind = "systemd" | "launchd" | "windows-task-scheduler";
export type NativeServiceStatus = "absent" | "stopped" | "running" | "failed";

export interface NativeManagerCapabilities {
	readonly maximumMemoryBytes: boolean;
	readonly maximumCpuPercent: boolean;
	readonly maximumTasks: boolean;
}

export interface NativeServiceState {
	readonly name: VehicleName;
	readonly status: NativeServiceStatus;
	readonly specHash?: string;
	readonly pid?: number;
}

export type InspectionOutcome =
	| { readonly ok: true; readonly services: readonly NativeServiceState[]; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface NativeServiceManager {
	readonly kind: NativeManagerKind;
	readonly capabilities: NativeManagerCapabilities;
	inspect(vehicles: readonly VehicleSpec[]): Promise<InspectionOutcome>;
}
