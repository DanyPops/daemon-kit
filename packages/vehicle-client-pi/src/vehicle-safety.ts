/**
 * Backend for `/safety`: resolves the tri-state policy (allow/ask/blocked)
 * an operation is actually gated by, and the per-operation override store a
 * human can edit to adjust it. registerVehicleTools/refreshVehicleToolAvailability
 * (see vehicle-pi.ts) consult classifyVehicleOperationSafety for tool
 * visibility; createTool()'s execute() consults it for the local
 * pre-invoke approval gate.
 */
import { type AtomicJsonFsAdapter, createAtomicJsonWriter, DEFAULT_APPROVAL_EFFECTS, type VehicleEffect } from "@danypops/vehicle-core";

export type VehicleSafetyState = "allow" | "ask" | "blocked";

export const VEHICLE_SAFETY_STATES: readonly VehicleSafetyState[] = ["allow", "ask", "blocked"];

export interface VehicleSafetyClassificationInput {
	readonly permissionsSatisfied: boolean;
	readonly effect: VehicleEffect;
	/** Defaults to DEFAULT_APPROVAL_EFFECTS, mirroring VehicleRegistry's own default -- a caller whose Vehicle server was configured with a different requireApprovalForEffects set should pass the same set here so /safety's "ask" classification matches reality. */
	readonly requireApprovalForEffects?: ReadonlySet<VehicleEffect>;
	readonly override?: VehicleSafetyState;
}

/**
 * Resolves an operation's real state. Precedence: an explicit per-operation
 * override always wins (a human's own /safety decision), then the
 * effect-level default, then a missing permission blocks. An override
 * winning over a permission-based block is deliberate: it only changes
 * local visibility/gating, never what the server actually authorizes at
 * invoke time -- invoking a permission-blocked operation a human overrode
 * to "allow" still fails server-side with permission-denied.
 */
export function classifyVehicleOperationSafety(input: VehicleSafetyClassificationInput): VehicleSafetyState {
	if (input.override) return input.override;
	if (!input.permissionsSatisfied) return "blocked";
	const gated = input.requireApprovalForEffects ?? new Set(DEFAULT_APPROVAL_EFFECTS);
	return gated.has(input.effect) ? "ask" : "allow";
}

export interface VehicleSafetyOverrideRecord {
	readonly vehicleName: string;
	readonly operationName: string;
	readonly state: VehicleSafetyState;
}

export interface VehicleSafetyPersistedSnapshot {
	readonly version: 1;
	readonly savedAt: number;
	readonly overrides: readonly VehicleSafetyOverrideRecord[];
}

export interface VehicleSafetyPersistenceAdapter {
	save(snapshot: VehicleSafetyPersistedSnapshot): Promise<void>;
	/** Returns undefined if there's nothing to restore, or what's on disk doesn't look like a real snapshot -- never throws for a corrupt/foreign file. */
	load(): Promise<VehicleSafetyPersistedSnapshot | undefined>;
}

function overrideKey(vehicleName: string, operationName: string): string {
	return `${vehicleName}/${operationName}`;
}

function isVehicleSafetyState(value: unknown): value is VehicleSafetyState {
	return value === "allow" || value === "ask" || value === "blocked";
}

function isVehicleSafetyOverrideRecord(value: unknown): value is VehicleSafetyOverrideRecord {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.vehicleName === "string" && typeof candidate.operationName === "string" && isVehicleSafetyState(candidate.state);
}

function isVehicleSafetyPersistedSnapshot(value: unknown): value is VehicleSafetyPersistedSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 1 &&
		typeof candidate.savedAt === "number" &&
		Array.isArray(candidate.overrides) &&
		candidate.overrides.every(isVehicleSafetyOverrideRecord)
	);
}

export interface CreateFileVehicleSafetyPersistenceOptions {
	readonly filePath: string;
	readonly fs: AtomicJsonFsAdapter;
	/** Called with whatever malformed value was found on disk, right before it's discarded in favor of an empty restore. */
	readonly onCorruptSnapshot?: (raw: unknown) => void;
}

/** Same shape as vehicle-server's createFileVehicleSchedulePersistence -- a corrupt or foreign file on disk never breaks restore, it's just discarded in favor of starting empty. */
export function createFileVehicleSafetyPersistence(options: CreateFileVehicleSafetyPersistenceOptions): VehicleSafetyPersistenceAdapter {
	const writer = createAtomicJsonWriter({ fs: options.fs });
	return {
		save: (snapshot) => writer.write(options.filePath, snapshot, { pretty: true }),
		async load() {
			const raw = await writer.read(options.filePath);
			if (raw === undefined) return undefined;
			if (!isVehicleSafetyPersistedSnapshot(raw)) {
				options.onCorruptSnapshot?.(raw);
				return undefined;
			}
			return raw;
		},
	};
}

/**
 * In-memory overrides, optionally durable via a VehicleSafetyPersistenceAdapter.
 * get() is always synchronous (a plain Map lookup) so registerVehicleTools/
 * refreshVehicleToolAvailability and the approval-gate check in vehicle-pi.ts
 * can consult it inline without threading async through every classification
 * call; set()/clear() persist (when an adapter is given) before resolving, so
 * a caller awaiting them knows the write actually landed.
 */
export class VehicleSafetyPolicyStore {
	private readonly overrides = new Map<string, VehicleSafetyOverrideRecord>();

	private constructor(private readonly persistence: VehicleSafetyPersistenceAdapter | undefined) {}

	/** Loads any existing snapshot up front (a no-op, empty store when no adapter is given -- the in-memory-only walking-skeleton case). */
	static async restore(persistence?: VehicleSafetyPersistenceAdapter): Promise<VehicleSafetyPolicyStore> {
		const store = new VehicleSafetyPolicyStore(persistence);
		const snapshot = await persistence?.load();
		for (const record of snapshot?.overrides ?? []) store.overrides.set(overrideKey(record.vehicleName, record.operationName), record);
		return store;
	}

	get(vehicleName: string, operationName: string): VehicleSafetyState | undefined {
		return this.overrides.get(overrideKey(vehicleName, operationName))?.state;
	}

	async set(vehicleName: string, operationName: string, state: VehicleSafetyState): Promise<void> {
		this.overrides.set(overrideKey(vehicleName, operationName), { vehicleName, operationName, state });
		await this.persist();
	}

	async clear(vehicleName: string, operationName: string): Promise<void> {
		if (!this.overrides.delete(overrideKey(vehicleName, operationName))) return;
		await this.persist();
	}

	list(): readonly VehicleSafetyOverrideRecord[] {
		return [...this.overrides.values()];
	}

	private async persist(): Promise<void> {
		if (!this.persistence) return;
		await this.persistence.save({ version: 1, savedAt: Date.now(), overrides: this.list() });
	}
}
