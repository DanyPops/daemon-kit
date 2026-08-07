import { manifestHash } from "../fleet/hash.js";
import type { VehicleSpec } from "../fleet/manifest.js";
import { capabilityDiagnostics, hasError, nativeServiceIdentity, seconds, sortedEnvEntries } from "./descriptor.js";
import type { DescriptorOutcome, NativeManagerCapabilities, NativeServiceStrategy } from "./service-manager.js";

const capabilities: NativeManagerCapabilities = Object.freeze({
	maximumMemoryBytes: true,
	maximumCpuPercent: true,
	maximumTasks: true,
	restartAlways: true,
	restartOnFailure: true,
	restartAttemptLimit: true,
	restartAttemptWindow: true,
});

function quote(value: string): string {
	let result = '"';
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (character === "\\") result += "\\\\";
		else if (character === '"') result += '\\"';
		else if (code < 32 || code === 127) result += `\\x${code.toString(16).padStart(2, "0")}`;
		else result += character;
	}
	return `${result}"`;
}

function generateDescriptor(vehicle: VehicleSpec): DescriptorOutcome {
	const diagnostics = capabilityDiagnostics(vehicle, capabilities);
	if (hasError(diagnostics)) return { ok: false, diagnostics };
	const specHash = manifestHash(vehicle);
	const unitName = `armada-${vehicle.name}.service`;
	const unit: string[] = ["[Unit]", `Description=Armada Vehicle ${vehicle.name}`, `X-Armada-SpecHash=${specHash}`];
	if (vehicle.restart.policy !== "never") {
		unit.push(`StartLimitIntervalSec=${seconds(vehicle.restart.windowMs)}`, `StartLimitBurst=${vehicle.restart.maxAttempts + 1}`);
	}
	unit.push(
		"",
		"[Service]",
		"Type=simple",
		'Environment="DAEMON_KIT_LAUNCH_PROVENANCE=service"',
		...sortedEnvEntries(vehicle).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`),
		`ExecStart=${[vehicle.executable, ...vehicle.arguments].map(quote).join(" ")}`,
	);
	if (vehicle.workingDirectory !== undefined) unit.push(`WorkingDirectory=${quote(vehicle.workingDirectory)}`);
	if (vehicle.restart.policy === "never") unit.push("Restart=no");
	else unit.push(`Restart=${vehicle.restart.policy}`, `RestartSec=${seconds(vehicle.restart.delayMs)}`);
	const resources = vehicle.resources;
	if (resources?.maximumMemoryBytes) unit.push(`MemoryMax=${resources.maximumMemoryBytes.value}`);
	if (resources?.maximumCpuPercent) unit.push(`CPUQuota=${resources.maximumCpuPercent.value}%`);
	if (resources?.maximumTasks) unit.push(`TasksMax=${resources.maximumTasks.value}`);
	unit.push("", "[Install]", "WantedBy=armada.target", "");
	return {
		ok: true,
		descriptor: Object.freeze({
			kind: "systemd",
			identity: nativeServiceIdentity(unitName),
			fileName: unitName,
			specHash,
			content: unit.join("\n"),
		}),
		diagnostics,
	};
}

export const systemdStrategy: NativeServiceStrategy = Object.freeze({ kind: "systemd", capabilities, generateDescriptor });
