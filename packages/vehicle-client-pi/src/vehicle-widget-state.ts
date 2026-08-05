/**
 * A Vehicle-projected Pi widget's own local rendering state must not be
 * lost when the user reloads or the conversation compacts -- a distinct
 * concern from Vehicle Jobs' own state persistence (a background
 * operation's lifecycle surviving a daemon restart) and Vehicle Watchers
 * (reacting to a remote resource's changes). Generalizes the two most
 * robust independently-found strategies for this behind one API:
 *
 *  - A durable sidecar file (the shared atomic-JSON writer -- temp+rename,
 *    survives a crash mid-write), read back first as the canonical source.
 *  - A bounded custom entry appended to the session's own persisted branch
 *    via pi.appendEntry(), replayed via ctx.sessionManager.getBranch() as a
 *    fallback when the sidecar is missing or corrupt (a fresh checkout of
 *    the project, a sidecar file deleted out-of-band, ...).
 *
 * The sidecar is the canonical source specifically because it has no size
 * bound of its own -- a widget's real state can be arbitrarily detailed.
 * The session-branch copy exists only as a fallback and is deliberately
 * bounded (maxEntryBytes, default matching vstack's own precedent): past
 * that bound it degrades to a small pointer ({truncated: true, sizeBytes}),
 * never risking a `/resume` crash from an oversized session JSONL entry.
 * Replaying from a truncated pointer recovers only that pointer, not the
 * real state -- an accepted, documented limitation of the fallback path.
 */
import { type AtomicJsonFsAdapter, createAtomicJsonWriter } from "@danypops/vehicle-core";
import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * ReadonlySessionManager itself isn't exported from the package root (only
 * used internally to type ExtensionContext.sessionManager) -- this minimal
 * structural interface is the one real method load() needs, so a caller can
 * pass ctx.sessionManager directly without this file importing an
 * unexported type.
 */
export interface SessionBranchReader {
	getBranch(fromId?: string): SessionEntry[];
}

const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024;

export interface ReloadSafeWidgetStateOptions {
	/** Unique per widget -- becomes both the session custom entry's customType and the sidecar file's own identity. Pick something namespaced, e.g. "papyrus.task-overlay". */
	readonly key: string;
	/** Where the sidecar file lives. Callers own path resolution (e.g. via daemonStateDir()) -- this helper has no opinion on directory layout. */
	readonly filePath: string;
	readonly fs: AtomicJsonFsAdapter;
	/** Hard bound on the session-branch copy's own serialized size. The sidecar file itself is never bounded by this. Defaults to 64KB, matching vstack's own BG_TASKS_SNAPSHOT_MAX_BYTES precedent. */
	readonly maxEntryBytes?: number;
}

export interface ReloadSafeWidgetState<T> {
	/**
	 * Persists `state` to the sidecar file (always, in full) and appends a
	 * best-effort, fingerprint-deduped custom entry to the session branch
	 * (truncated to a pointer past maxEntryBytes). Never throws -- a failed
	 * write here must never break the widget interaction that triggered it;
	 * callers that need to know a save failed should check the resolved
	 * boolean rather than wrapping this in their own try/catch.
	 */
	save(pi: ExtensionAPI, state: T): Promise<boolean>;
	/**
	 * Reads the sidecar first (canonical). Falls back to replaying the most
	 * recent matching custom entry from the session's own branch when the
	 * sidecar is missing or corrupt. Returns undefined when neither source
	 * has anything, or the only available entry was itself a truncated
	 * pointer (nothing real left to recover).
	 */
	load(sessionManager: SessionBranchReader): Promise<T | undefined>;
}

interface TruncatedPointer {
	readonly truncated: true;
	readonly sizeBytes: number;
}

function isTruncatedPointer(value: unknown): value is TruncatedPointer {
	return typeof value === "object" && value !== null && (value as { truncated?: unknown }).truncated === true;
}

function byteLength(json: string): number {
	return Buffer.byteLength(json, "utf8");
}

/** A cheap, non-cryptographic fingerprint -- collision risk is irrelevant here, this only gates "did anything change since the last save()" to avoid appending an identical redundant entry on every re-render. */
function fingerprint(json: string): string {
	let hash = 0;
	for (let i = 0; i < json.length; i++) {
		hash = (Math.imul(31, hash) + json.charCodeAt(i)) | 0;
	}
	return `${json.length}:${hash}`;
}

export function createReloadSafeWidgetState<T>(options: ReloadSafeWidgetStateOptions): ReloadSafeWidgetState<T> {
	const writer = createAtomicJsonWriter({ fs: options.fs });
	const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
	let lastAppendedFingerprint: string | undefined;

	return {
		async save(pi, state) {
			let sidecarOk = true;
			try {
				await writer.write(options.filePath, state);
			} catch {
				sidecarOk = false;
			}

			const json = JSON.stringify(state);
			const fp = fingerprint(json);
			if (fp !== lastAppendedFingerprint) {
				const payload: T | TruncatedPointer = byteLength(json) > maxEntryBytes ? { truncated: true, sizeBytes: byteLength(json) } : state;
				try {
					pi.appendEntry(options.key, payload);
					lastAppendedFingerprint = fp;
				} catch {
					// Best-effort: the sidecar write above is this call's real
					// durability guarantee; a failed session-branch append never
					// fails save() outright.
				}
			}

			return sidecarOk;
		},

		async load(sessionManager) {
			try {
				const sidecar = await writer.read(options.filePath);
				if (sidecar !== undefined) return sidecar as T;
			} catch {
				// Falls through to the session-branch replay below.
			}

			const branch = sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as SessionEntry;
				if (entry.type !== "custom" || (entry as CustomEntry).customType !== options.key) continue;
				const data = (entry as CustomEntry<T | TruncatedPointer>).data;
				if (data === undefined || isTruncatedPointer(data)) return undefined;
				return data;
			}
			return undefined;
		},
	};
}
