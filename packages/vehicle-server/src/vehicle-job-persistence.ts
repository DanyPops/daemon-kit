/**
 * Durable state for VehicleJobStore, built on vehicle-core's own
 * createAtomicJsonWriter -- one JSON file, temp+rename, never a half
 * written snapshot. VehicleJobStore decides *what* to persist (already
 * bounded by its own retention sweep before this is ever called); this
 * module only decides *how*, and refuses to let a corrupt or foreign-shaped
 * file on disk break restore -- load() returns undefined instead of
 * throwing for anything that doesn't look like a real snapshot.
 */
import type {
	AtomicJsonFsAdapter,
	VehicleFailure,
	VehicleJobStatus,
	VehicleJobTerminationReason,
	VehicleJobWakeEntry,
} from "@danypops/vehicle-core";
import { createAtomicJsonWriter } from "@danypops/vehicle-core";

export interface VehicleJobPersistedRecord {
	readonly jobId: string;
	readonly operationName: string;
	readonly operationVersion: number;
	readonly status: VehicleJobStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly instanceToken: string;
	readonly delivered: boolean;
	readonly terminationReason?: VehicleJobTerminationReason;
	readonly output?: unknown;
	readonly error?: VehicleFailure;
	readonly wakeEntries: readonly VehicleJobWakeEntry[];
}

export interface VehicleJobPersistedSnapshot {
	readonly version: 1;
	readonly savedAt: number;
	readonly jobs: readonly VehicleJobPersistedRecord[];
}

export interface VehicleJobPersistenceAdapter {
	save(snapshot: VehicleJobPersistedSnapshot): Promise<void>;
	/** Returns undefined if there's nothing to restore, or what's on disk doesn't look like a real snapshot -- never throws for a corrupt/foreign file. */
	load(): Promise<VehicleJobPersistedSnapshot | undefined>;
}

function isVehicleJobWakeEntry(value: unknown): value is VehicleJobWakeEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.seq === "number" && typeof candidate.at === "number" && "progress" in candidate;
}

function isVehicleJobPersistedRecord(value: unknown): value is VehicleJobPersistedRecord {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.jobId === "string" &&
		typeof candidate.operationName === "string" &&
		typeof candidate.operationVersion === "number" &&
		typeof candidate.status === "string" &&
		typeof candidate.createdAt === "number" &&
		typeof candidate.updatedAt === "number" &&
		typeof candidate.instanceToken === "string" &&
		typeof candidate.delivered === "boolean" &&
		Array.isArray(candidate.wakeEntries) &&
		candidate.wakeEntries.every(isVehicleJobWakeEntry)
	);
}

function isVehicleJobPersistedSnapshot(value: unknown): value is VehicleJobPersistedSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 1 &&
		typeof candidate.savedAt === "number" &&
		Array.isArray(candidate.jobs) &&
		candidate.jobs.every(isVehicleJobPersistedRecord)
	);
}

export interface CreateFileVehicleJobPersistenceOptions {
	readonly filePath: string;
	readonly fs: AtomicJsonFsAdapter;
	/** Called with whatever malformed value was found on disk, right before it's discarded in favor of an empty restore. Optional -- a caller with no logger just loses the diagnostic, not correctness. */
	readonly onCorruptSnapshot?: (raw: unknown) => void;
}

export function createFileVehicleJobPersistence(options: CreateFileVehicleJobPersistenceOptions): VehicleJobPersistenceAdapter {
	const writer = createAtomicJsonWriter({ fs: options.fs });
	return {
		save: (snapshot) => writer.write(options.filePath, snapshot),
		async load() {
			const raw = await writer.read(options.filePath);
			if (raw === undefined) return undefined;
			if (!isVehicleJobPersistedSnapshot(raw)) {
				options.onCorruptSnapshot?.(raw);
				return undefined;
			}
			return raw;
		},
	};
}
