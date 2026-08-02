import type { Diagnostic } from "../fleet/diagnostic.js";
import type { ManifestHash, NativeServiceIdentity, VehicleName } from "../fleet/identity.js";
import type { VehicleSpec } from "../fleet/manifest.js";

export type NativeManagerKind = "systemd" | "launchd" | "windows-task-scheduler";
export type NativeServiceStatus = "absent" | "stopped" | "running" | "failed";

export interface NativeManagerCapabilities {
	readonly maximumMemoryBytes: boolean;
	readonly maximumCpuPercent: boolean;
	readonly maximumTasks: boolean;
	readonly restartAlways: boolean;
	readonly restartOnFailure: boolean;
	readonly restartAttemptLimit: boolean;
	readonly restartAttemptWindow: boolean;
}

export interface NativeServiceState {
	readonly name: VehicleName;
	readonly status: NativeServiceStatus;
	readonly specHash?: string;
	readonly pid?: number;
}

export interface NativeServiceDescriptor {
	readonly kind: NativeManagerKind;
	readonly identity: NativeServiceIdentity;
	readonly fileName: string;
	readonly specHash: ManifestHash;
	readonly content: string;
}

export type DescriptorOutcome =
	| { readonly ok: true; readonly descriptor: NativeServiceDescriptor; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface NativeServiceStrategy {
	readonly kind: NativeManagerKind;
	readonly capabilities: NativeManagerCapabilities;
	generateDescriptor(vehicle: VehicleSpec): DescriptorOutcome;
}

export type InspectionOutcome =
	| { readonly ok: true; readonly services: readonly NativeServiceState[]; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface NativeServiceManager {
	readonly kind: NativeManagerKind;
	readonly capabilities: NativeManagerCapabilities;
	inspect(vehicles: readonly VehicleSpec[]): Promise<InspectionOutcome>;
}

export type NativeOperationOutcome =
	| { readonly ok: true; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface NativeServiceController extends NativeServiceManager {
	replaceDescriptorAtomically(descriptor: NativeServiceDescriptor): Promise<NativeOperationOutcome>;
	start(identity: NativeServiceIdentity): Promise<NativeOperationOutcome>;
	stop(identity: NativeServiceIdentity): Promise<NativeOperationOutcome>;
}

export interface ReadinessProbe {
	waitUntilReady(vehicle: VehicleSpec): Promise<NativeOperationOutcome>;
}
