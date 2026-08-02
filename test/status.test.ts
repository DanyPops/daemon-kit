import { describe, expect, it } from "vitest";
import { buildFleetStatus, manifestHash, systemdStrategy, type NativeServiceState, type ObservedProcess } from "../src/index.js";
import { manifest, vehicle } from "./fixtures.js";

describe("buildFleetStatus", () => {
	it("joins desired, native, handle, and process state", () => {
		const spec = vehicle();
		const native: NativeServiceState[] = [{ name: spec.name, status: "running", pid: 42, specHash: manifestHash(spec) }];
		const processes: ObservedProcess[] = [{ pid: 42, executable: spec.executable, command: `${spec.executable} serve` }];
		const report = buildFleetStatus({
			manifest: manifest([spec]),
			nativeServices: native,
			processes,
			handles: new Map([[spec.name, { host: "127.0.0.1", port: 4312, pid: 42 }]]),
			strategy: systemdStrategy,
			executableExists: () => true,
		});
		expect(report.vehicles).toMatchObject([
			{ name: "papyrus", nativeStatus: "running", nativePid: 42, handlePid: 42, ready: true, descriptorDrift: false },
		]);
		expect(report.diagnostics).toEqual([]);
	});

	it("reports missing executables, drift, failed services, stale handles, and unmanaged duplicates", () => {
		const spec = vehicle();
		const report = buildFleetStatus({
			manifest: manifest([spec]),
			nativeServices: [{ name: spec.name, status: "failed", pid: 42, specHash: "stale" }],
			processes: [
				{ pid: 42, executable: spec.executable, command: `${spec.executable} serve` },
				{ pid: 43, executable: spec.executable, command: `${spec.executable} serve` },
			],
			handles: new Map([[spec.name, { host: "127.0.0.1", port: 4312, pid: 99 }]]),
			strategy: systemdStrategy,
			executableExists: () => false,
		});
		expect(report.diagnostics.map((item) => item.code)).toEqual([
			"VEHICLE_EXECUTABLE_MISSING",
			"NATIVE_DESCRIPTOR_DRIFT",
			"NATIVE_SERVICE_FAILED",
			"VEHICLE_HANDLE_STALE",
			"VEHICLE_PROCESS_DUPLICATE",
			"VEHICLE_PROCESS_UNMANAGED",
		]);
	});

	it("rejects unbounded process inventories", () => {
		const outcome = buildFleetStatus({
			manifest: manifest(),
			nativeServices: [],
			processes: Array.from({ length: 1001 }, (_, pid) => ({ pid: pid + 1, executable: "/bin/x", command: "/bin/x" })),
			handles: new Map(),
			strategy: systemdStrategy,
			executableExists: () => true,
		});
		expect(outcome.diagnostics).toMatchObject([{ code: "PROCESS_INVENTORY_TOO_LARGE", severity: "error" }]);
		expect(outcome.vehicles).toEqual([]);
	});
});
