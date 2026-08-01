/** Job store on top of VehicleRegistry.resolveForBackground(): submit once, poll/tail/steer/cancel by id, with persistence across a restart and delivery-confirmed bounded retention. */
import { randomUUID } from "node:crypto";
import {
	createStaticVehicleJobWakeLog,
	resolveVehicleJobTerminationReason,
	selectVehicleJobsForEviction,
	VehicleError,
	type VehicleFailure,
	type VehicleJobEvictionCandidate,
	type VehicleJobNotifyMode,
	type VehicleJobStatus,
	VehicleJobSteerChannel,
	type VehicleJobTerminationReason,
	type VehicleJobWakeBudget,
	type VehicleJobWakeEntry,
	VehicleJobWakeLog,
	type VehicleJobWakeLogReader,
	type VehicleOperationContext,
	type VehiclePrincipal,
	vehicleJobIdentityMatches,
} from "@danypops/vehicle-core";
import type { VehicleJobPersistedSnapshot, VehicleJobPersistenceAdapter } from "./vehicle-job-persistence.js";
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
	readonly delivered: boolean;
	readonly terminationReason?: VehicleJobTerminationReason;
	readonly output?: unknown;
	readonly error?: VehicleFailure;
}

export interface VehicleJobTailResult {
	readonly entries: readonly VehicleJobWakeEntry[];
	readonly cursor: number;
}

export interface VehicleJobStoreOptions {
	/** Defaults to Date.now. */
	readonly now?: () => number;
	/** Omit for a pure in-memory store (the walking skeleton's original behavior) -- restore()/persistence are then both no-ops. */
	readonly persistence?: VehicleJobPersistenceAdapter;
	/** Hard cap on total retained job records; a running job is never a candidate. Defaults to 1000. */
	readonly maxRetainedJobs?: number;
	/** How long a delivered terminal job is kept before becoming eviction-eligible. Defaults to 24h. */
	readonly deliveredRetentionMs?: number;
	/** Bounds a job's own steer-input buffer. Defaults to 64. */
	readonly maxSteerQueueSize?: number;
	/** Persistence is best-effort: a write failure (e.g. disk full) must never break a job's own execution. Defaults to a no-op. */
	readonly onPersistError?: (error: unknown) => void;
}

export interface VehicleJobRestoreResult {
	readonly restoredCount: number;
	/** Restored records that were "running" when the process died and so could never be resumed -- resolved to status "failed", terminationReason "orphaned". */
	readonly orphanedCount: number;
}

interface JobRecord {
	readonly jobId: string;
	readonly operationName: string;
	readonly operationVersion: number;
	status: VehicleJobStatus;
	readonly createdAt: number;
	updatedAt: number;
	readonly instanceToken: string;
	delivered: boolean;
	output?: unknown;
	error?: VehicleFailure;
	terminationReason?: VehicleJobTerminationReason;
	wakeLog: VehicleJobWakeLogReader;
	steerChannel: VehicleJobSteerChannel;
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

function closedSteerChannel(): VehicleJobSteerChannel {
	const channel = new VehicleJobSteerChannel(0);
	channel.close();
	return channel;
}

const DEFAULT_MAX_RETAINED_JOBS = 1_000;
const DEFAULT_DELIVERED_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_STEER_QUEUE_SIZE = 64;

export class VehicleJobStore {
	private readonly jobs = new Map<string, JobRecord>();
	private readonly now: () => number;
	private readonly persistence?: VehicleJobPersistenceAdapter;
	private readonly maxRetainedJobs: number;
	private readonly deliveredRetentionMs: number;
	private readonly maxSteerQueueSize: number;
	private readonly onPersistError: (error: unknown) => void;
	/** Fresh per construction -- see vehicleJobIdentityMatches. Stamped onto every job this instance submits; a persisted record's own token only ever matches the instance that wrote it. */
	readonly instanceToken: string = randomUUID();
	private persistChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly registry: VehicleRegistry,
		options: VehicleJobStoreOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.persistence = options.persistence;
		this.maxRetainedJobs = options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS;
		this.deliveredRetentionMs = options.deliveredRetentionMs ?? DEFAULT_DELIVERED_RETENTION_MS;
		this.maxSteerQueueSize = options.maxSteerQueueSize ?? DEFAULT_MAX_STEER_QUEUE_SIZE;
		this.onPersistError = options.onPersistError ?? (() => {});
	}

	/**
	 * Loads whatever this store's persistence adapter has on disk, reconciling
	 * any job left "running" into an orphaned failure (see
	 * vehicleJobIdentityMatches -- a fresh instanceToken never matches a
	 * persisted one, so every restored "running" record is, by construction,
	 * from a process that's gone). Call once at daemon startup, before serving
	 * any request. A no-op if no persistence adapter was configured, or
	 * nothing was ever saved.
	 */
	async restore(): Promise<VehicleJobRestoreResult> {
		if (!this.persistence) return { restoredCount: 0, orphanedCount: 0 };
		const snapshot = await this.persistence.load();
		if (!snapshot) return { restoredCount: 0, orphanedCount: 0 };

		let orphanedCount = 0;
		for (const persisted of snapshot.jobs) {
			const orphaned = persisted.status === "running" && !vehicleJobIdentityMatches(persisted.instanceToken, this.instanceToken);
			const record: JobRecord = {
				jobId: persisted.jobId,
				operationName: persisted.operationName,
				operationVersion: persisted.operationVersion,
				status: orphaned ? "failed" : persisted.status,
				createdAt: persisted.createdAt,
				updatedAt: persisted.updatedAt,
				instanceToken: persisted.instanceToken,
				delivered: persisted.delivered,
				output: orphaned ? undefined : persisted.output,
				error: orphaned
					? {
							code: "job-orphaned-by-restart",
							category: "internal",
							message: `Job ${persisted.jobId} was still running when its daemon restarted and cannot be resumed`,
							retryable: false,
						}
					: persisted.error,
				terminationReason: orphaned ? "orphaned" : persisted.terminationReason,
				wakeLog: createStaticVehicleJobWakeLog(persisted.wakeEntries),
				steerChannel: closedSteerChannel(),
				controller: new AbortController(),
				finalized: true,
				cancelRequested: false,
			};
			this.jobs.set(record.jobId, record);
			if (orphaned) orphanedCount++;
		}
		this.sweep();
		return { restoredCount: snapshot.jobs.length, orphanedCount };
	}

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
		const wakeLog = new VehicleJobWakeLog({ notifyMode: options.notifyMode ?? "transition", budget: wakeBudget, now: this.now });
		const steerChannel = new VehicleJobSteerChannel(this.maxSteerQueueSize);
		const record: JobRecord = {
			jobId,
			operationName: name,
			operationVersion: version,
			status: "running",
			createdAt: this.now(),
			updatedAt: this.now(),
			instanceToken: this.instanceToken,
			delivered: false,
			wakeLog,
			steerChannel,
			controller,
			finalized: false,
			cancelRequested: false,
		};
		this.jobs.set(jobId, record);
		this.schedulePersist();

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
			steerInputs: steerChannel,
			reportProgress: (progress) => {
				wakeLog.append(progress);
				record.updatedAt = this.now();
				this.schedulePersist();
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
			delivered: record.delivered,
			...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
			...(record.output !== undefined ? { output: record.output } : {}),
			...(record.error ? { error: record.error } : {}),
		};
	}

	/** Entries after `sinceCursor` (0 for everything so far), plus a cursor for the next call. Never blocks. Works the same for a live job and one restored after a restart. */
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

	/** Pushes new input to an already-running job's handler, if it opted in via context.steerInputs. Distinct from cancel(): the job keeps running. */
	steer(jobId: string, input: unknown): void {
		const record = this.requireJob(jobId);
		if (record.finalized) {
			throw new VehicleError("job-not-steerable", `Job ${jobId} is already ${record.status} and cannot accept new input`, {
				category: "conflict",
			});
		}
		const result = record.steerChannel.push(input);
		if (!result.accepted) {
			throw new VehicleError("job-steer-queue-full", `Job ${jobId}'s steer input queue is full`, { category: "capacity" });
		}
	}

	/**
	 * Marks a terminal job's result as delivered to its caller -- only a
	 * delivered job is ever eligible for the retention sweep's eviction.
	 * Idempotent. Safe to call on a still-running job (a no-op until it
	 * settles), though the intended caller is "I successfully read this
	 * job's final poll() result."
	 */
	markDelivered(jobId: string): void {
		const record = this.requireJob(jobId);
		if (!record.delivered) {
			record.delivered = true;
			record.updatedAt = this.now();
			this.schedulePersist();
		}
		this.sweep();
	}

	/** Resolves once every persistence write scheduled so far has settled. No-op if no persistence adapter is configured. Intended for tests and a clean daemon shutdown, not the request path. */
	async flushPersistence(): Promise<void> {
		await this.persistChain;
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
		record.steerChannel.close();

		const candidates: VehicleJobTerminationReason[] = [reason];
		if (record.cancelRequested) candidates.push("canceled");
		const resolved = resolveVehicleJobTerminationReason(candidates);

		record.terminationReason = resolved;
		record.status = resolved === "succeeded" ? "succeeded" : resolved === "canceled" ? "canceled" : "failed";
		record.output = outcome.output;
		record.error = resolved === "canceled" && !outcome.error ? undefined : outcome.error;
		record.updatedAt = this.now();
		this.schedulePersist();
		this.sweep();
	}

	/** Bounded-retention eviction: see selectVehicleJobsForEviction for the actual policy. A running job is never a candidate. */
	private sweep(): void {
		const candidates: VehicleJobEvictionCandidate[] = [...this.jobs.values()].map((record) => ({
			jobId: record.jobId,
			status: record.status,
			delivered: record.delivered,
			updatedAt: record.updatedAt,
		}));
		const evictedIds = selectVehicleJobsForEviction(candidates, {
			maxRetainedJobs: this.maxRetainedJobs,
			deliveredRetentionMs: this.deliveredRetentionMs,
			now: this.now(),
		});
		if (evictedIds.length === 0) return;
		for (const id of evictedIds) this.jobs.delete(id);
		this.schedulePersist();
	}

	/**
	 * Writes always run one at a time, chained onto persistChain, so two
	 * mutations racing (a progress tick landing while a finalize() write is
	 * still in flight, say) never produce two overlapping writes to the same
	 * file. Each write reflects whatever this.jobs looks like at the moment it
	 * actually runs, not at the moment it was scheduled. Best-effort: a save()
	 * failure is reported via onPersistError and otherwise swallowed -- a
	 * disk-full daemon must keep running jobs, not crash them.
	 */
	private schedulePersist(): void {
		if (!this.persistence) return;
		const persistence = this.persistence;
		this.persistChain = this.persistChain.then(async () => {
			const snapshot: VehicleJobPersistedSnapshot = {
				version: 1,
				savedAt: this.now(),
				jobs: [...this.jobs.values()].map((record) => ({
					jobId: record.jobId,
					operationName: record.operationName,
					operationVersion: record.operationVersion,
					status: record.status,
					createdAt: record.createdAt,
					updatedAt: record.updatedAt,
					instanceToken: record.instanceToken,
					delivered: record.delivered,
					...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
					...(record.output !== undefined ? { output: record.output } : {}),
					...(record.error ? { error: record.error } : {}),
					wakeEntries: record.wakeLog.since(0),
				})),
			};
			try {
				await persistence.save(snapshot);
			} catch (error) {
				this.onPersistError(error);
			}
		});
	}
}
