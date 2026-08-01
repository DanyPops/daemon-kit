/** Pure pieces of Vehicle Jobs: a termination-reason resolver and a bounded wake-log accumulator. Orchestration lives in vehicle-server's VehicleJobStore. */

export type VehicleJobStatus = "running" | "succeeded" | "failed" | "canceled";

/** Highest precedence first -- an explicit cancel always wins even if the handler also settled around the same time. "orphaned" is a restart-reconciliation outcome: a job that was still "running" when its process died, so nothing ever really failed or succeeded -- the record's own status just goes stale. */
export const VEHICLE_JOB_TERMINATION_PRECEDENCE = ["canceled", "timeout", "orphaned", "failed", "succeeded"] as const;
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

/** Read-only replay side of a wake log -- both a live VehicleJobWakeLog and a restored (no-longer-appendable) job satisfy this with the same tail() semantics. */
export interface VehicleJobWakeLogReader {
	since(cursor: number): readonly VehicleJobWakeEntry[];
	readonly cursor: number;
}

/** Wraps a fixed, already-finalized list of entries (e.g. restored from disk) in the same reader shape a live VehicleJobWakeLog exposes, so VehicleJobStore.tail() doesn't need to special-case a restored job. */
export function createStaticVehicleJobWakeLog(entries: readonly VehicleJobWakeEntry[]): VehicleJobWakeLogReader {
	const sorted = [...entries].sort((a, b) => a.seq - b.seq);
	const cursor = sorted.length > 0 ? sorted[sorted.length - 1]!.seq : 0;
	return {
		since: (cursorArg) => sorted.filter((entry) => entry.seq > cursorArg),
		cursor,
	};
}

/**
 * A job's mid-flight input channel -- the "steer" primitive. Bounded FIFO:
 * push() while a handler isn't yet reading buffers up to maxQueueSize, then
 * refuses further input rather than growing unboundedly or silently
 * overwriting an unread entry. A handler consumes it via `for await (const
 * input of context.steerInputs)`, which ends cleanly once close() is
 * called (VehicleJobStore does this at job finalization).
 */
export interface VehicleJobSteerPushResult {
	readonly accepted: boolean;
	readonly dropReason?: "queue-full" | "channel-closed";
}

export class VehicleJobSteerChannel implements AsyncIterable<unknown> {
	private readonly buffer: unknown[] = [];
	private readonly waiters: ((result: IteratorResult<unknown>) => void)[] = [];
	private closed = false;

	constructor(private readonly maxQueueSize: number = 64) {}

	push(value: unknown): VehicleJobSteerPushResult {
		if (this.closed) return { accepted: false, dropReason: "channel-closed" };
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value, done: false });
			return { accepted: true };
		}
		if (this.buffer.length >= this.maxQueueSize) return { accepted: false, dropReason: "queue-full" };
		this.buffer.push(value);
		return { accepted: true };
	}

	/** Ends every pending and future iteration with done:true; further push() calls report "channel-closed". Idempotent. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: (): Promise<IteratorResult<unknown>> => {
				if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift(), done: false });
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
}

/**
 * Vehicle Jobs run as in-process promises, not child processes -- there is
 * no PID to reuse, but the same identity-confusion risk vstack's
 * {pid, startToken, comm} design guards against still applies in a
 * generalized form: a persisted job record written by one process
 * instance must never be mistaken for one this (possibly restarted)
 * instance can still resolve. Each VehicleJobStore construction gets a
 * fresh random instanceToken; a persisted record's own stamped token only
 * ever matches the instance that wrote it. A mismatch means "the original
 * run is gone", the same conclusion vstack's identityMatches() reaches by
 * comparing a live process's actual pid/start-time/command against a
 * stored snapshot -- this is that same check with no process to inspect.
 */
export function vehicleJobIdentityMatches(recordInstanceToken: string, currentInstanceToken: string): boolean {
	return recordInstanceToken === currentInstanceToken;
}

/** Minimal shape selectVehicleJobsForEviction needs from a job record -- kept separate from VehicleJobSnapshot so vehicle-server doesn't have to construct a full snapshot just to ask "should this be swept". */
export interface VehicleJobEvictionCandidate {
	readonly jobId: string;
	readonly status: VehicleJobStatus;
	readonly delivered: boolean;
	readonly updatedAt: number;
}

export interface VehicleJobRetentionOptions {
	/** Hard cap on total retained job records (of any status). A running job is never evicted regardless of this cap. */
	readonly maxRetainedJobs: number;
	/** A delivered terminal job becomes eligible for eviction once this many ms have passed since it was delivered (== updatedAt at delivery time). */
	readonly deliveredRetentionMs: number;
	readonly now: number;
}

/**
 * Pure eviction-selection policy, kept separate from VehicleJobStore's own
 * bookkeeping so the bounded-retention rule is independently testable.
 * Preference order: (1) delivered and past deliveredRetentionMs, oldest
 * first; (2) once still over maxRetainedJobs, any delivered terminal job,
 * oldest first; (3) only as a last resort, an undelivered terminal job,
 * oldest first -- a real loss (a caller may still want that result), but
 * an unbounded store is a worse failure mode. A running job is never a
 * candidate.
 */
export function selectVehicleJobsForEviction(
	candidates: readonly VehicleJobEvictionCandidate[],
	options: VehicleJobRetentionOptions,
): readonly string[] {
	const terminal = candidates.filter((candidate) => candidate.status !== "running");
	const byAgeAscending = (a: VehicleJobEvictionCandidate, b: VehicleJobEvictionCandidate) => a.updatedAt - b.updatedAt;

	const evicted = new Set<string>();
	for (const candidate of terminal) {
		if (candidate.delivered && options.now - candidate.updatedAt >= options.deliveredRetentionMs) evicted.add(candidate.jobId);
	}

	const remainingCount = () => candidates.length - evicted.size;
	if (remainingCount() > options.maxRetainedJobs) {
		const deliveredOldestFirst = terminal.filter((candidate) => candidate.delivered && !evicted.has(candidate.jobId)).sort(byAgeAscending);
		for (const candidate of deliveredOldestFirst) {
			if (remainingCount() <= options.maxRetainedJobs) break;
			evicted.add(candidate.jobId);
		}
	}
	if (remainingCount() > options.maxRetainedJobs) {
		const undeliveredOldestFirst = terminal
			.filter((candidate) => !candidate.delivered && !evicted.has(candidate.jobId))
			.sort(byAgeAscending);
		for (const candidate of undeliveredOldestFirst) {
			if (remainingCount() <= options.maxRetainedJobs) break;
			evicted.add(candidate.jobId);
		}
	}
	return [...evicted];
}
