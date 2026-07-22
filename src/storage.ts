/**
 * bun:sqlite bootstrap: pragmas + PRAGMA user_version migration runner.
 * Generalizes the skeleton that was identical across web-spider-daemon,
 * jittor, and papyrus's db.ts (down to the same header comment admitting
 * "Mirrors jittor/src/db.ts"), and closes a real gap in pi-packed's --
 * whose db.ts only ever set journal_mode, missing busy_timeout,
 * foreign_keys, optimize, and any versioned migration runner at all.
 */
import { Database, type DatabaseOptions } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Migration {
	/** Target PRAGMA user_version this migration produces. Must be applied in ascending order starting from the current version + 1. */
	version: number;
	up: (db: Database) => void;
}

export interface OpenSqliteOptions {
	migrations: Migration[];
	busyTimeoutMs?: number;
	/** Passed through to `new Database(path, databaseOptions)` verbatim -- e.g. { create: true, strict: true }. */
	databaseOptions?: DatabaseOptions;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

function userVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Opens (creating parent directories as needed) and migrates a bun:sqlite
 * database. Safe to call on every daemon start: migrations already applied
 * (per PRAGMA user_version) are skipped.
 */
export function openSqliteWithPragmas(path: string, options: OpenSqliteOptions): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, options.databaseOptions);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

	const sorted = [...options.migrations].sort((a, b) => a.version - b.version);
	const targetVersion = sorted.at(-1)?.version ?? 0;
	let current = userVersion(db);
	// A database newer than every migration this caller knows about means a
	// downgrade (older code opening a database a newer version created) --
	// fail closed rather than silently opening a schema this code doesn't
	// fully understand.
	if (current > targetVersion) {
		throw new Error(`database schema ${current} is newer than supported ${targetVersion}`);
	}
	for (const migration of sorted) {
		if (migration.version <= current) continue;
		if (migration.version !== current + 1) {
			throw new Error(`migration gap: at version ${current}, next migration targets ${migration.version} (expected ${current + 1})`);
		}
		db.transaction(() => {
			migration.up(db);
			db.exec(`PRAGMA user_version = ${migration.version}`);
		})();
		current = migration.version;
	}

	db.exec("PRAGMA optimize=0x10002");
	return db;
}

/** Best-effort periodic maintenance -- callers wire these into serveDaemon's maintenanceTasks. */
export function checkpoint(db: Database): void {
	db.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

export function optimize(db: Database): void {
	db.exec("PRAGMA optimize");
}
