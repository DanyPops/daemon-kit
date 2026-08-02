import { lstat, readFile } from "node:fs/promises";
import { diagnostic } from "./diagnostic.js";
import type { VehicleSpec } from "./manifest.js";
import type { NativeOperationOutcome, ReadinessProbe } from "../native/service-manager.js";

const MAX_HANDLE_BYTES = 4_096;

interface VehicleHandle {
	readonly host: "127.0.0.1";
	readonly port: number;
	readonly pid: number;
}

export interface HandleReadinessDependencies {
	readonly readHandle?: (path: string) => Promise<unknown>;
	readonly isPidAlive?: (pid: number) => boolean;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function readVehicleHandleFile(path: string): Promise<unknown> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HANDLE_BYTES) return undefined;
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isHandle(value: unknown): value is VehicleHandle {
	if (typeof value !== "object" || value === null) return false;
	const handle = value as Partial<VehicleHandle>;
	return (
		handle.host === "127.0.0.1" &&
		Number.isInteger(handle.port) &&
		handle.port !== undefined &&
		handle.port >= 1 &&
		handle.port <= 65_535 &&
		Number.isInteger(handle.pid) &&
		handle.pid !== undefined &&
		handle.pid > 0
	);
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createHandleReadinessProbe(dependencies: HandleReadinessDependencies = {}): ReadinessProbe {
	const load = dependencies.readHandle ?? readVehicleHandleFile;
	const alive = dependencies.isPidAlive ?? isPidAlive;
	const clock = dependencies.now ?? Date.now;
	const wait = dependencies.sleep ?? sleep;
	return {
		async waitUntilReady(vehicle: VehicleSpec): Promise<NativeOperationOutcome> {
			const deadline = clock() + vehicle.readiness.timeoutMs;
			while (true) {
				const handle = await load(vehicle.handlePath);
				if (isHandle(handle) && alive(handle.pid)) return { ok: true, diagnostics: [] };
				const remaining = deadline - clock();
				if (remaining <= 0) {
					return {
						ok: false,
						diagnostics: [
							diagnostic("VEHICLE_READINESS_TIMEOUT", "error", `/vehicles/${vehicle.name}`, "Vehicle handle did not become ready"),
						],
					};
				}
				await wait(Math.min(vehicle.readiness.pollIntervalMs, remaining));
			}
		},
	};
}
