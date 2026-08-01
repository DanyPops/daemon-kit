/** Pure pieces of Vehicle Jobs: a termination-reason resolver and a bounded wake-log accumulator. Orchestration lives in vehicle-server's VehicleJobStore. */

export type VehicleJobStatus = "running" | "succeeded" | "failed" | "canceled";

/** Highest precedence first -- an explicit cancel always wins even if the handler also settled around the same time. */
export const VEHICLE_JOB_TERMINATION_PRECEDENCE = ["canceled", "timeout", "failed", "succeeded"] as const;
export type VehicleJobTerminationReason = (typeof VEHICLE_JOB_TERMINATION_PRECEDENCE)[number];

export function resolveVehicleJobTerminationReason(candidates: readonly VehicleJobTerminationReason[]): VehicleJobTerminationReason {
	if (candidates.length === 0) throw new Error("resolveVehicleJobTerminationReason requires at least one candidate");
	for (const reason of VEHICLE_JOB_TERMINATION_PRECEDENCE) {
		if (candidates.includes(reason)) return reason;
	}
	throw new Error(`Unrecognized Vehicle job termination candidate(s): ${candidates.join(", ")}`);
}

/** "always" keeps every notification; "transition" drops one identical to the last (hash dedup); "first-only" keeps just the first. */
export type VehicleJobNotifyMode = "always" | "transition" | "first-only";

export interface VehicleJobWakeBudget {
	readonly maxCount: number;
	readonly maxBytes: number;
}

export type VehicleJobWakeDropReason =
	| "count-budget-exhausted"
	| "byte-budget-exhausted"
	| "deduplicated-transition"
	| "superseded-by-first-only";

export interface VehicleJobWakeEntry {
	readonly seq: number;
	readonly at: number;
	readonly progress: unknown;
}

export interface VehicleJobWakeAppendResult {
	readonly accepted: boolean;
	readonly entry?: VehicleJobWakeEntry;
	readonly dropReason?: VehicleJobWakeDropReason;
}

export interface VehicleJobWakeLogOptions {
	readonly notifyMode: VehicleJobNotifyMode;
	readonly budget: VehicleJobWakeBudget;
	/** Defaults to Date.now. */
	readonly now?: () => number;
}

/** Bounds a job's accumulated progress notifications by count+bytes, same discipline as enforcePayloadSize but across a job's whole lifetime. */
export class VehicleJobWakeLog {
	private readonly entries: VehicleJobWakeEntry[] = [];
	private usedBytes = 0;
	private nextSeq = 1;
	private lastHash: string | undefined;
	private acceptedFirst = false;
	private readonly now: () => number;

	constructor(private readonly options: VehicleJobWakeLogOptions) {
		this.now = options.now ?? Date.now;
	}

	append(progress: unknown): VehicleJobWakeAppendResult {
		if (this.options.notifyMode === "first-only" && this.acceptedFirst) {
			return { accepted: false, dropReason: "superseded-by-first-only" };
		}
		const serialized = safeJsonStringify(progress);
		if (this.options.notifyMode === "transition") {
			const hash = fnv1aHash(serialized);
			if (hash === this.lastHash) return { accepted: false, dropReason: "deduplicated-transition" };
			this.lastHash = hash;
		}
		const bytes = new TextEncoder().encode(serialized).byteLength;
		if (this.entries.length >= this.options.budget.maxCount) return { accepted: false, dropReason: "count-budget-exhausted" };
		if (this.usedBytes + bytes > this.options.budget.maxBytes) return { accepted: false, dropReason: "byte-budget-exhausted" };

		const entry: VehicleJobWakeEntry = { seq: this.nextSeq++, at: this.now(), progress };
		this.entries.push(entry);
		this.usedBytes += bytes;
		this.acceptedFirst = true;
		return { accepted: true, entry };
	}

	/** Entries with seq strictly greater than `cursor`. */
	since(cursor: number): readonly VehicleJobWakeEntry[] {
		return this.entries.filter((entry) => entry.seq > cursor);
	}

	/** Highest seq issued so far (0 if none accepted yet). */
	get cursor(): number {
		return this.nextSeq - 1;
	}
}

function safeJsonStringify(value: unknown): string {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new Error("Vehicle job progress value is not JSON-serializable", { cause: error });
	}
	if (serialized === undefined) throw new Error("Vehicle job progress value is not JSON-serializable");
	return serialized;
}

/** Non-cryptographic (FNV-1a) -- dedup only. */
function fnv1aHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}
