/**
 * Durable state for VehicleScheduler, built on vehicle-core's own
 * createAtomicJsonWriter -- same shape as vehicle-job-persistence.ts.
 * VehicleScheduler decides *what* to persist (already bounded by its own
 * per-owner cap); this module only decides *how*, and refuses to let a
 * corrupt or foreign-shaped file on disk break restore -- load() returns
 * undefined instead of throwing for anything that doesn't look like a real
 * snapshot.
 */
import type { AtomicJsonFsAdapter, VehicleScheduleAction, VehicleScheduledEntry, VehicleScheduleTrigger } from "@danypops/vehicle-core";
import { createAtomicJsonWriter } from "@danypops/vehicle-core";

export interface VehicleSchedulePersistedSnapshot {
	readonly version: 1;
	readonly savedAt: number;
	readonly entries: readonly VehicleScheduledEntry[];
}

export interface VehicleSchedulePersistenceAdapter {
	save(snapshot: VehicleSchedulePersistedSnapshot): Promise<void>;
	/** Returns undefined if there's nothing to restore, or what's on disk doesn't look like a real snapshot -- never throws for a corrupt/foreign file. */
	load(): Promise<VehicleSchedulePersistedSnapshot | undefined>;
}

function isVehicleScheduleTrigger(value: unknown): value is VehicleScheduleTrigger {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "at") return typeof candidate.at === "number";
	if (candidate.kind === "every") return typeof candidate.intervalMs === "number";
	return false;
}

function isVehicleScheduleAction(value: unknown): value is VehicleScheduleAction {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.name !== "string" || typeof candidate.version !== "number") return false;
	if (candidate.kind === "operation") return "input" in candidate;
	if (candidate.kind === "event") return "payload" in candidate;
	return false;
}

function isVehicleScheduledEntry(value: unknown): value is VehicleScheduledEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.scheduleId === "string" &&
		typeof candidate.owner === "string" &&
		typeof candidate.createdAt === "number" &&
		typeof candidate.nextFireAt === "number" &&
		isVehicleScheduleTrigger(candidate.trigger) &&
		isVehicleScheduleAction(candidate.action)
	);
}

function isVehicleSchedulePersistedSnapshot(value: unknown): value is VehicleSchedulePersistedSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 1 &&
		typeof candidate.savedAt === "number" &&
		Array.isArray(candidate.entries) &&
		candidate.entries.every(isVehicleScheduledEntry)
	);
}

export interface CreateFileVehicleSchedulePersistenceOptions {
	readonly filePath: string;
	readonly fs: AtomicJsonFsAdapter;
	/** Called with whatever malformed value was found on disk, right before it's discarded in favor of an empty restore. Optional -- a caller with no logger just loses the diagnostic, not correctness. */
	readonly onCorruptSnapshot?: (raw: unknown) => void;
}

export function createFileVehicleSchedulePersistence(
	options: CreateFileVehicleSchedulePersistenceOptions,
): VehicleSchedulePersistenceAdapter {
	const writer = createAtomicJsonWriter({ fs: options.fs });
	return {
		save: (snapshot) => writer.write(options.filePath, snapshot),
		async load() {
			const raw = await writer.read(options.filePath);
			if (raw === undefined) return undefined;
			if (!isVehicleSchedulePersistedSnapshot(raw)) {
				options.onCorruptSnapshot?.(raw);
				return undefined;
			}
			return raw;
		},
	};
}
