import { manifestHash } from "../fleet/hash.js";
import type { VehicleSpec } from "../fleet/manifest.js";
import { capabilityDiagnostics, hasError, nativeServiceIdentity, xmlEscape } from "./descriptor.js";
import type { DescriptorOutcome, NativeManagerCapabilities, NativeServiceStrategy } from "./service-manager.js";

const capabilities: NativeManagerCapabilities = Object.freeze({
	maximumMemoryBytes: false,
	maximumCpuPercent: false,
	maximumTasks: false,
	restartAlways: true,
	restartOnFailure: true,
	restartAttemptLimit: false,
	restartAttemptWindow: false,
});

function keyValue(key: string, value: string): readonly string[] {
	return [`  <key>${key}</key>`, `  <string>${xmlEscape(value)}</string>`];
}

function generateDescriptor(vehicle: VehicleSpec): DescriptorOutcome {
	const diagnostics = capabilityDiagnostics(vehicle, capabilities);
	if (hasError(diagnostics)) return { ok: false, diagnostics };
	const specHash = manifestHash(vehicle);
	const label = `dev.danypops.armada.${vehicle.name}`;
	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		`  <!-- Armada spec hash: ${specHash} -->`,
		...keyValue("Label", label),
		"  <key>ProgramArguments</key>",
		"  <array>",
		...[vehicle.executable, ...vehicle.arguments].map((argument) => `    <string>${xmlEscape(argument)}</string>`),
		"  </array>",
		"  <key>RunAtLoad</key>",
		"  <true/>",
	];
	if (vehicle.workingDirectory !== undefined) lines.push(...keyValue("WorkingDirectory", vehicle.workingDirectory));
	lines.push("</dict>", "</plist>", "");
	return {
		ok: true,
		descriptor: Object.freeze({
			kind: "launchd",
			identity: nativeServiceIdentity(label),
			fileName: `${label}.plist`,
			specHash,
			content: lines.join("\n"),
		}),
		diagnostics,
	};
}

export const launchdStrategy: NativeServiceStrategy = Object.freeze({ kind: "launchd", capabilities, generateDescriptor });
