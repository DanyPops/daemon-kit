import { manifestHash } from "../fleet/hash.js";
import type { VehicleSpec } from "../fleet/manifest.js";
import { capabilityDiagnostics, hasError, nativeServiceIdentity, seconds, xmlEscape } from "./descriptor.js";
import type { DescriptorOutcome, NativeManagerCapabilities, NativeServiceStrategy } from "./service-manager.js";

const capabilities: NativeManagerCapabilities = Object.freeze({
	maximumMemoryBytes: false,
	maximumCpuPercent: false,
	maximumTasks: false,
	restartAlways: false,
	restartOnFailure: true,
	restartAttemptLimit: true,
	restartAttemptWindow: false,
});

function quoteArgument(value: string): string {
	if (value.length > 0 && !/[\s"]/.test(value)) return value;
	let result = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes++;
			continue;
		}
		if (character === '"') {
			result += "\\".repeat(backslashes * 2 + 1);
			result += '"';
			backslashes = 0;
			continue;
		}
		result += "\\".repeat(backslashes) + character;
		backslashes = 0;
	}
	return `${result}${"\\".repeat(backslashes * 2)}"`;
}

function restartSettings(vehicle: VehicleSpec): readonly string[] {
	if (vehicle.restart.policy !== "on-failure") return [];
	return [
		"    <RestartOnFailure>",
		`      <Interval>PT${seconds(vehicle.restart.delayMs)}S</Interval>`,
		`      <Count>${vehicle.restart.maxAttempts}</Count>`,
		"    </RestartOnFailure>",
	];
}

function generateDescriptor(vehicle: VehicleSpec): DescriptorOutcome {
	const diagnostics = capabilityDiagnostics(vehicle, capabilities);
	if (hasError(diagnostics)) return { ok: false, diagnostics };
	const specHash = manifestHash(vehicle);
	const identity = `\\Armada\\${vehicle.name}`;
	const commandText = [vehicle.executable, ...vehicle.arguments].map(quoteArgument).join(" ");
	const argumentsText = `/d /s /c "set DAEMON_KIT_LAUNCH_PROVENANCE=service&& ${commandText}"`;
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		`  <!-- Armada spec hash: ${specHash} -->`,
		"  <Principals>",
		'    <Principal id="Author">',
		"      <LogonType>InteractiveToken</LogonType>",
		"      <RunLevel>LeastPrivilege</RunLevel>",
		"    </Principal>",
		"  </Principals>",
		"  <Triggers>",
		"    <LogonTrigger>",
		"      <Enabled>true</Enabled>",
		"    </LogonTrigger>",
		"  </Triggers>",
		"  <Settings>",
		"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
		"    <StartWhenAvailable>true</StartWhenAvailable>",
		"    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		...restartSettings(vehicle),
		"  </Settings>",
		"  <Actions Context=\"Author\">",
		"    <Exec>",
		"      <Command>cmd.exe</Command>",
		`      <Arguments>${xmlEscape(argumentsText)}</Arguments>`,
		...(vehicle.workingDirectory === undefined ? [] : [`      <WorkingDirectory>${xmlEscape(vehicle.workingDirectory)}</WorkingDirectory>`]),
		"    </Exec>",
		"  </Actions>",
		"</Task>",
		"",
	];
	return {
		ok: true,
		descriptor: Object.freeze({
			kind: "windows-task-scheduler",
			identity: nativeServiceIdentity(identity),
			fileName: `${vehicle.name}.xml`,
			specHash,
			content: lines.join("\r\n"),
		}),
		diagnostics,
	};
}

export const windowsTaskSchedulerStrategy: NativeServiceStrategy = Object.freeze({
	kind: "windows-task-scheduler",
	capabilities,
	generateDescriptor,
});
