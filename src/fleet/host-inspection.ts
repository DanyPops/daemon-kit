import type { VehicleName } from "./identity.js";
import type { VehicleSpec } from "./manifest.js";
import type { ObservedProcess, ObservedVehicleHandle } from "./status.js";
import type { CommandRunner } from "../native/controller.js";

const MAX_PROCESSES = 1_000;

function parseUnixProcesses(stdout: string): readonly ObservedProcess[] {
	const processes: ObservedProcess[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		processes.push({ pid: Number(match[1]), executable: match[2] ?? "", command: match[3] ?? "" });
		if (processes.length > MAX_PROCESSES) break;
	}
	return processes;
}

function parseWindowsProcesses(stdout: string): readonly ObservedProcess[] {
	if (!stdout.trim()) return [];
	try {
		const value = JSON.parse(stdout) as unknown;
		const rows = Array.isArray(value) ? value : [value];
		return rows.slice(0, MAX_PROCESSES + 1).flatMap((row) => {
			if (typeof row !== "object" || row === null) return [];
			const process = row as { ProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown };
			if (!Number.isInteger(process.ProcessId) || typeof process.ExecutablePath !== "string") return [];
			return [{ pid: process.ProcessId as number, executable: process.ExecutablePath, command: typeof process.CommandLine === "string" ? process.CommandLine : "" }];
		});
	} catch {
		return [];
	}
}

export async function inspectHostProcesses(platform: NodeJS.Platform, runner: CommandRunner): Promise<readonly ObservedProcess[]> {
	if (platform === "win32") {
		const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
		const outcome = await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
		return outcome.ok ? parseWindowsProcesses(outcome.stdout) : [];
	}
	const outcome = await runner.run("ps", ["-axo", "pid=,comm=,args="]);
	return outcome.ok ? parseUnixProcesses(outcome.stdout) : [];
}

export async function readVehicleHandles(
	vehicles: readonly VehicleSpec[],
	readHandle: (path: string) => Promise<unknown>,
): Promise<ReadonlyMap<VehicleName, ObservedVehicleHandle>> {
	const handles = new Map<VehicleName, ObservedVehicleHandle>();
	for (const vehicle of vehicles) {
		const value = await readHandle(vehicle.handlePath);
		if (typeof value !== "object" || value === null) continue;
		const handle = value as Partial<ObservedVehicleHandle>;
		if (handle.host !== "127.0.0.1" || !Number.isInteger(handle.port) || !Number.isInteger(handle.pid)) continue;
		handles.set(vehicle.name, handle as ObservedVehicleHandle);
	}
	return handles;
}
