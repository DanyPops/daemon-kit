/**
 * Real timers + persistence + registry wiring for vehicle-core's own pure
 * Vehicle Scheduler shapes -- the stateful half of the split vehicle-jobs.ts
 * established. A "repeat" entry is re-armed via a fresh setTimeout after
 * each fire (computed from nextFireAtAfterFire) rather than setInterval,
 * so restore() and a normal fire share one arming code path and neither
 * drifts against wall-clock time the way setInterval can.
 */
import { randomUUID } from "node:crypto";
import type { VehicleScheduleAction, VehicleScheduledEntry, VehicleScheduleTrigger } from "@danypops/vehicle-core";
import {
	DEFAULT_MAX_SCHEDULES_PER_OWNER,
	initialFireAt,
	nextFireAtAfterFire,
	nextFireAtAfterRestore,
	VehicleScheduleLimitExceeded,
} from "@danypops/vehicle-core";
import type { VehicleRegistry } from "./vehicle-registry.js";
import type { VehicleSchedulePersistedSnapshot, VehicleSchedulePersistenceAdapter } from "./vehicle-schedule-persistence.js";

export interface VehicleScheduleHandle {
	readonly scheduleId: string;
	cancel(): boolean;
}

export interface VehicleSchedulerOptions {
	readonly now?: () => number;
	readonly persistence?: VehicleSchedulePersistenceAdapter;
	/** Defaults to DEFAULT_MAX_SCHEDULES_PER_OWNER. */
	readonly maxSchedulesPerOwner?: number;
	readonly onPersistError?: (error: unknown) => void;
	/** A fired operation/event action that itself throws is reported here and otherwise swallowed -- one bad fire must never stop the scheduler or crash the daemon. */
	readonly onFireError?: (entry: VehicleScheduledEntry, error: unknown) => void;
}

interface TimerEntry {
	entry: VehicleScheduledEntry;
	timer: ReturnType<typeof setTimeout>;
}

export interface VehicleScheduleRestoreResult {
	readonly restoredCount: number;
}

export class VehicleScheduler {
	private readonly timers = new Map<string, TimerEntry>();
	private readonly now: () => number;
	private readonly persistence?: VehicleSchedulePersistenceAdapter;
	private readonly maxSchedulesPerOwner: number;
	private readonly onPersistError: (error: unknown) => void;
	private readonly onFireError: (entry: VehicleScheduledEntry, error: unknown) => void;
	private persistChain: Promise<void> = Promise.resolve();
	private stopped = false;

	constructor(
		private readonly registry: VehicleRegistry,
		options: VehicleSchedulerOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.persistence = options.persistence;
		this.maxSchedulesPerOwner = options.maxSchedulesPerOwner ?? DEFAULT_MAX_SCHEDULES_PER_OWNER;
		this.onPersistError = options.onPersistError ?? (() => {});
		this.onFireError = options.onFireError ?? (() => {});
	}

	/**
	 * Loads whatever this scheduler's persistence adapter has on disk and
	 * re-arms a real timer for every entry -- call once at daemon startup,
	 * before serving any request. A no-op if no persistence adapter was
	 * configured, or nothing was ever saved.
	 */
	async restore(): Promise<VehicleScheduleRestoreResult> {
		if (!this.persistence) return { restoredCount: 0 };
		const snapshot = await this.persistence.load();
		if (!snapshot) return { restoredCount: 0 };

		const now = this.now();
		for (const persisted of snapshot.entries) {
			const nextFireAt = nextFireAtAfterRestore(persisted.trigger, persisted.nextFireAt, now);
			this.arm({ ...persisted, nextFireAt });
		}
		this.schedulePersist();
		return { restoredCount: snapshot.entries.length };
	}

	schedule(owner: string, trigger: VehicleScheduleTrigger, action: VehicleScheduleAction): VehicleScheduleHandle {
		if (!owner.trim()) throw new Error("Vehicle schedule owner must not be empty");
		if (this.countForOwner(owner) >= this.maxSchedulesPerOwner) throw new VehicleScheduleLimitExceeded(owner, this.maxSchedulesPerOwner);

		const now = this.now();
		const entry: VehicleScheduledEntry = {
			scheduleId: randomUUID(),
			owner,
			trigger,
			action,
			createdAt: now,
			nextFireAt: initialFireAt(trigger, now),
		};
		this.arm(entry);
		this.schedulePersist();
		return { scheduleId: entry.scheduleId, cancel: () => this.cancel(entry.scheduleId) };
	}

	/** Idempotent-shaped -- returns false for an already-canceled or unknown id, matching WatchRegistry.remove()'s own "no error on a second call" convention. */
	cancel(scheduleId: string): boolean {
		const timerEntry = this.timers.get(scheduleId);
		if (!timerEntry) return false;
		clearTimeout(timerEntry.timer);
		this.timers.delete(scheduleId);
		this.schedulePersist();
		return true;
	}

	list(owner?: string): readonly VehicleScheduledEntry[] {
		const all = [...this.timers.values()].map((timerEntry) => timerEntry.entry);
		return owner === undefined ? all : all.filter((entry) => entry.owner === owner);
	}

	/** Clears every real timer without touching persisted state -- a clean process shutdown/test teardown, not a cancellation of the schedules themselves (restore() re-arms them next time this scheduler starts). */
	stop(): void {
		this.stopped = true;
		for (const { timer } of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	private countForOwner(owner: string): number {
		let count = 0;
		for (const { entry } of this.timers.values()) {
			if (entry.owner === owner) count++;
		}
		return count;
	}

	private arm(entry: VehicleScheduledEntry): void {
		const delayMs = Math.max(0, entry.nextFireAt - this.now());
		const timer = setTimeout(() => this.fire(entry), delayMs);
		this.timers.set(entry.scheduleId, { entry, timer });
	}

	private fire(entry: VehicleScheduledEntry): void {
		if (this.stopped) return;
		void this.runAction(entry).finally(() => {
			if (this.stopped) return;
			const nextFireAt = nextFireAtAfterFire(entry.trigger, this.now());
			if (nextFireAt === undefined) this.timers.delete(entry.scheduleId);
			else this.arm({ ...entry, nextFireAt });
			this.schedulePersist();
		});
	}

	private async runAction(entry: VehicleScheduledEntry): Promise<void> {
		try {
			if (entry.action.kind === "operation") {
				await this.registry.invoke(entry.action.name, entry.action.version, entry.action.input, {
					permissions: entry.action.permissions,
				});
			} else {
				this.registry.emit(entry.action.name, entry.action.version, entry.action.payload);
			}
		} catch (error) {
			this.onFireError(entry, error);
		}
	}

	/**
	 * Writes always run one at a time, chained onto persistChain, mirroring
	 * VehicleJobStore's own schedulePersist() discipline. Each write reflects
	 * whatever this.timers looks like at the moment it actually runs, not at
	 * the moment it was scheduled. Best-effort: a save() failure is reported
	 * via onPersistError and otherwise swallowed.
	 */
	private schedulePersist(): void {
		if (!this.persistence) return;
		const persistence = this.persistence;
		this.persistChain = this.persistChain.then(async () => {
			const snapshot: VehicleSchedulePersistedSnapshot = {
				version: 1,
				savedAt: this.now(),
				entries: [...this.timers.values()].map((timerEntry) => timerEntry.entry),
			};
			try {
				await persistence.save(snapshot);
			} catch (error) {
				this.onPersistError(error);
			}
		});
	}
}
