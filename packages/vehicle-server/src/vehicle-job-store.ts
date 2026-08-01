/** In-memory job store on top of VehicleRegistry.resolveForBackground(): submit once, poll/tail/cancel by id. No persistence, steer, or delivery-confirmation yet -- walking skeleton. */
import { randomUUID } from "node:crypto";
import {
	resolveVehicleJobTerminationReason,
	VehicleError,
	type VehicleFailure,
	type VehicleJobNotifyMode,
	type VehicleJobStatus,
	type VehicleJobTerminationReason,
	type VehicleJobWakeBudget,
	type VehicleJobWakeEntry,
	VehicleJobWakeLog,
	type VehicleOperationContext,
	type VehiclePrincipal,
} from "@danypops/vehicle-core";
import type { VehicleRegistry } from "./vehicle-registry.js";

export interface VehicleJobSubmitOptions {
	readonly permissions?: readonly string[];
	readonly principal?: VehiclePrincipal;
	readonly idempotencyKey?: string;
	readonly expectedRevision?: string | number;
	readonly approvalCapability?: string;
	readonly correlationId?: string;
	/** Defaults to "transition". */
	readonly notifyMode?: VehicleJobNotifyMode;
	/** Defaults to background.defaultWakeBudget; clamped to background.maxWakeBudget either way. */
	readonly wakeBudget?: VehicleJobWakeBudget;
	/** No default -- unset means the job runs until it settles or is canceled. */
	readonly maxLifetimeMs?: number;
}

export interface VehicleJobSnapshot {
	readonly jobId: string;
	readonly operationName: string;
	readonly operationVersion: number;
	readonly status: VehicleJobStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly terminationReason?: VehicleJobTerminationReason;
	readonly output?: unknown;
	readonly error?: VehicleFailure;
}

export interface VehicleJobTailResult {
	readonly entries: readonly VehicleJobWakeEntry[];
	readonly cursor: number;
}

interface JobRecord {
	readonly jobId: string;
	readonly operationName: string;
	readonly operationVersion: number;
	status: VehicleJobStatus;
	readonly createdAt: number;
	updatedAt: number;
	output?: unknown;
	error?: VehicleFailure;
	terminationReason?: VehicleJobTerminationReason;
	readonly wakeLog: VehicleJobWakeLog;
	readonly controller: AbortController;
	finalized: boolean;
	cancelRequested: boolean;
	lifetimeTimer?: ReturnType<typeof setTimeout>;
}

function clampBudget(requested: VehicleJobWakeBudget, ceiling: VehicleJobWakeBudget): VehicleJobWakeBudget {
	return { maxCount: Math.min(requested.maxCount, ceiling.maxCount), maxBytes: Math.min(requested.maxBytes, ceiling.maxBytes) };
}

function toFailure(error: unknown): VehicleFailure {
	if (error instanceof VehicleError) return error.toFailure();
	return { code: "internal", category: "internal", message: error instanceof Error ? error.message : String(error), retryable: false };
}

export class VehicleJobStore {
	private readonly jobs = new Map<string, JobRecord>();

	constructor(
		private readonly registry: VehicleRegistry,
		private readonly now: () => number = Date.now,
	) {}

	/** Validates and starts a background-capable operation; returns its job id immediately without waiting for the handler to make any progress. */
	submit(name: string, version: number, input: unknown, options: VehicleJobSubmitOptions = {}): { jobId: string } {
		const jobId = randomUUID();
		const resolution = this.registry.resolveForBackground(name, version, input, {
			operationId: jobId,
			correlationId: options.correlationId,
			permissions: options.permissions,
			principal: options.principal,
			idempotencyKey: options.idempotencyKey,
			expectedRevision: options.expectedRevision,
			approvalCapability: options.approvalCapability,
		});

		const wakeBudget = clampBudget(options.wakeBudget ?? resolution.background.defaultWakeBudget, resolution.background.maxWakeBudget);
		const controller = new AbortController();
		const record: JobRecord = {
			jobId,
			operationName: name,
			operationVersion: version,
			status: "running",
			createdAt: this.now(),
			updatedAt: this.now(),
			wakeLog: new VehicleJobWakeLog({ notifyMode: options.notifyMode ?? "transition", budget: wakeBudget, now: this.now }),
			controller,
			finalized: false,
			cancelRequested: false,
		};
		this.jobs.set(jobId, record);

		if (options.maxLifetimeMs !== undefined) {
			record.lifetimeTimer = setTimeout(() => {
				controller.abort();
				this.finalize(record, "timeout", {
					error: {
						code: "job-timeout",
						category: "timeout",
						message: `Job ${jobId} exceeded its ${options.maxLifetimeMs}ms lifetime`,
						retryable: false,
					},
				});
			}, options.maxLifetimeMs);
		}

		// No automatic per-call timeout here (unlike invoke()) -- only cancel() and maxLifetimeMs enforce a limit.
		const context: VehicleOperationContext<unknown> = {
			input: resolution.parsedInput,
			operationId: jobId,
			correlationId: options.correlationId,
			signal: controller.signal,
			deadline: Number.POSITIVE_INFINITY,
			permissions: Object.freeze([...(options.permissions ?? [])]),
			principal: options.principal,
			idempotencyKey: options.idempotencyKey,
			expectedRevision: options.expectedRevision,
			approvalCapability: options.approvalCapability,
			reportProgress: (progress) => {
				record.wakeLog.append(progress);
				record.updatedAt = this.now();
			},
		};

		resolution.run(context).then(
			(output) => this.finalize(record, "succeeded", { output }),
			(error) => this.finalize(record, "failed", { error: toFailure(error) }),
		);

		return { jobId };
	}

	/** Never blocks -- current status, plus output/error once terminal. */
	poll(jobId: string): VehicleJobSnapshot {
		const record = this.requireJob(jobId);
		return {
			jobId: record.jobId,
			operationName: record.operationName,
			operationVersion: record.operationVersion,
			status: record.status,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
			...(record.output !== undefined ? { output: record.output } : {}),
			...(record.error ? { error: record.error } : {}),
		};
	}

	/** Entries after `sinceCursor` (0 for everything so far), plus a cursor for the next call. Never blocks. */
	tail(jobId: string, sinceCursor = 0): VehicleJobTailResult {
		const record = this.requireJob(jobId);
		return { entries: record.wakeLog.since(sinceCursor), cursor: record.wakeLog.cursor };
	}

	/** No-op against an already-terminal job. */
	cancel(jobId: string): void {
		const record = this.requireJob(jobId);
		record.cancelRequested = true;
		if (!record.finalized) record.controller.abort();
	}

	private requireJob(jobId: string): JobRecord {
		const record = this.jobs.get(jobId);
		if (!record) throw new VehicleError("job-not-found", `No Vehicle job found for id ${jobId}`, { category: "not_found" });
		return record;
	}

	/** Idempotent -- a handler settling and a lifetime timer can both race to call this; only the first has any effect. Cancel always wins the precedence check. */
	private finalize(record: JobRecord, reason: VehicleJobTerminationReason, outcome: { output?: unknown; error?: VehicleFailure }): void {
		if (record.finalized) return;
		record.finalized = true;
		if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer);

		const candidates: VehicleJobTerminationReason[] = [reason];
		if (record.cancelRequested) candidates.push("canceled");
		const resolved = resolveVehicleJobTerminationReason(candidates);

		record.terminationReason = resolved;
		record.status = resolved === "succeeded" ? "succeeded" : resolved === "canceled" ? "canceled" : "failed";
		record.output = outcome.output;
		record.error = resolved === "canceled" && !outcome.error ? undefined : outcome.error;
		record.updatedAt = this.now();
	}
}
