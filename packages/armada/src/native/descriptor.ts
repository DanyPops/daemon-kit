import { type Diagnostic, diagnostic } from "../fleet/diagnostic.js";
import { createNativeServiceIdentity, type NativeServiceIdentity } from "../fleet/identity.js";
import type { VehicleResources, VehicleSpec } from "../fleet/manifest.js";
import type { NativeManagerCapabilities } from "./service-manager.js";

const RESOURCE_KEYS = ["maximumMemoryBytes", "maximumCpuPercent", "maximumTasks"] as const;

export function nativeServiceIdentity(value: string): NativeServiceIdentity {
	const outcome = createNativeServiceIdentity(value);
	if (!outcome.ok) throw new Error(`invalid native service identity: ${outcome.reason}`);
	return outcome.value;
}

function resourceDiagnostics(resources: VehicleResources | undefined, capabilities: NativeManagerCapabilities): Diagnostic[] {
	if (!resources) return [];
	const diagnostics: Diagnostic[] = [];
	for (const key of RESOURCE_KEYS) {
		const requirement = resources[key];
		if (!requirement || capabilities[key]) continue;
		const required = requirement.enforcement === "required";
		diagnostics.push(
			diagnostic(
				required ? "NATIVE_RESOURCE_UNSUPPORTED_REQUIRED" : "NATIVE_RESOURCE_UNSUPPORTED_OPTIONAL",
				required ? "error" : "warning",
				`/resources/${key}`,
				`${key} is not supported by this native manager`,
			),
		);
	}
	return diagnostics;
}

function restartDiagnostics(vehicle: VehicleSpec, capabilities: NativeManagerCapabilities): Diagnostic[] {
	if (vehicle.restart.policy === "never") return [];
	const supportsMode = vehicle.restart.policy === "always" ? capabilities.restartAlways : capabilities.restartOnFailure;
	if (!supportsMode) {
		return [
			diagnostic(
				"NATIVE_RESTART_MODE_UNSUPPORTED",
				"error",
				"/restart/policy",
				`${vehicle.restart.policy} is not supported by this native manager`,
			),
		];
	}
	if (!capabilities.restartAttemptLimit) {
		return [
			diagnostic(
				"NATIVE_RESTART_ATTEMPT_LIMIT_UNSUPPORTED",
				"error",
				"/restart/maxAttempts",
				"bounded restart attempts are not supported by this native manager",
			),
		];
	}
	if (!capabilities.restartAttemptWindow) {
		return [
			diagnostic(
				"NATIVE_RESTART_WINDOW_UNSUPPORTED",
				"warning",
				"/restart/windowMs",
				"restart attempts are bounded, but the native manager cannot enforce the requested time window",
			),
		];
	}
	return [];
}

function descriptorTextDiagnostics(vehicle: VehicleSpec): Diagnostic[] {
	const values = [
		["/executable", vehicle.executable],
		...vehicle.arguments.map((value, index) => [`/arguments/${index}`, value] as const),
		...(vehicle.workingDirectory === undefined ? [] : [["/workingDirectory", vehicle.workingDirectory] as const]),
	] as const;
	for (const [path, value] of values) {
		const hasControlCharacter = [...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		});
		if (hasControlCharacter) {
			return [diagnostic("NATIVE_DESCRIPTOR_TEXT_INVALID", "error", path, "native descriptor text cannot contain control characters")];
		}
	}
	return [];
}

export function capabilityDiagnostics(vehicle: VehicleSpec, capabilities: NativeManagerCapabilities): readonly Diagnostic[] {
	return Object.freeze([
		...descriptorTextDiagnostics(vehicle),
		...resourceDiagnostics(vehicle.resources, capabilities),
		...restartDiagnostics(vehicle, capabilities),
	]);
}

export function hasError(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some((item) => item.severity === "error");
}

export function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function seconds(milliseconds: number): string {
	return String(milliseconds / 1_000).replace(/\.0+$/, "");
}
