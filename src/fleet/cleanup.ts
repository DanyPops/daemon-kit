import { diagnostic, type Diagnostic } from "./diagnostic.js";
import { cleanupPlanHash } from "./hash.js";
import type { CleanupPlanHash, VehicleName } from "./identity.js";
import type { VehicleSpec } from "./manifest.js";
import { matchesVehicleProcess, type ObservedProcess, type ObservedVehicleHandle } from "./status.js";
import type { NativeOperationOutcome } from "../native/service-manager.js";

const MAX_PROCESSES = 1_000;

export interface CleanupConsequence {
	readonly pid: number;
	readonly executable: string;
	readonly provenance: "unmanaged";
	readonly signal: "SIGTERM";
	readonly interruption: "in-flight requests may fail";
	readonly ownsLiveHandle: boolean;
}

export interface CleanupPlan {
	readonly vehicle: VehicleName;
	readonly planHash: CleanupPlanHash;
	readonly consequences: readonly CleanupConsequence[];
}

export type CleanupPlanOutcome =
	| { readonly ok: true; readonly plan: CleanupPlan }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export type CleanupExecutionOutcome =
	| { readonly ok: true; readonly terminatedPids: readonly number[]; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export function planDuplicateCleanup(
	vehicle: VehicleSpec,
	managedPid: number | undefined,
	handle: ObservedVehicleHandle | undefined,
	processes: readonly ObservedProcess[],
): CleanupPlanOutcome {
	if (processes.length > MAX_PROCESSES) {
		return { ok: false, diagnostics: [diagnostic("PROCESS_INVENTORY_TOO_LARGE", "error", "/processes", "process inventory exceeds 1000 entries")] };
	}
	const consequences = processes
		.filter((process) => matchesVehicleProcess(vehicle, process) && process.pid !== managedPid)
		.map((process) =>
			Object.freeze({
				pid: process.pid,
				executable: process.executable,
				provenance: "unmanaged" as const,
				signal: "SIGTERM" as const,
				interruption: "in-flight requests may fail" as const,
				ownsLiveHandle: handle?.pid === process.pid,
			}),
		)
		.sort((left, right) => left.pid - right.pid);
	const content = { vehicle: vehicle.name, consequences };
	return { ok: true, plan: Object.freeze({ ...content, planHash: cleanupPlanHash(content) }) };
}

export interface ExecuteCleanupRequest {
	readonly plan: CleanupPlan;
	readonly approval: string;
	readonly vehicle: VehicleSpec;
	readonly managedPid: number | undefined;
	readonly handle: ObservedVehicleHandle | undefined;
	readonly currentProcesses: () => Promise<readonly ObservedProcess[]>;
	readonly terminate: (pid: number) => Promise<NativeOperationOutcome>;
}

export async function executeCleanup(request: ExecuteCleanupRequest): Promise<CleanupExecutionOutcome> {
	if (request.approval !== request.plan.planHash) {
		return { ok: false, diagnostics: [diagnostic("CLEANUP_APPROVAL_INVALID", "error", "/approve", "approval must equal the current cleanup plan hash")] };
	}
	const current = planDuplicateCleanup(request.vehicle, request.managedPid, request.handle, await request.currentProcesses());
	if (!current.ok) return current;
	if (current.plan.planHash !== request.plan.planHash) {
		return { ok: false, diagnostics: [diagnostic("CLEANUP_PLAN_STALE", "error", "/", "process state changed after cleanup planning")] };
	}
	const terminatedPids: number[] = [];
	for (const consequence of current.plan.consequences) {
		const outcome = await request.terminate(consequence.pid);
		if (!outcome.ok) return outcome;
		terminatedPids.push(consequence.pid);
	}
	return { ok: true, terminatedPids: Object.freeze(terminatedPids), diagnostics: [] };
}
