/**
 * SQLite bootstrap: pragmas + PRAGMA user_version migration runner. Backed by
 * bun:sqlite under Bun and node:sqlite everywhere else (see openRawDatabase).
 * Generalizes the skeleton that was identical across web-spider-daemon,
 * jittor, and papyrus's db.ts (down to the same header comment admitting
 * "Mirrors jittor/src/db.ts"), and closes a real gap in pi-packed's --
 * whose db.ts only ever set journal_mode, missing busy_timeout,
 * foreign_keys, optimize, and any versioned migration runner at all.
 *
 * The version-gap/downgrade-checking migration ALGORITHM (runMigrations) is
 * separated from bun:sqlite's concrete API so it stays open for extension: a
 * consumer whose storage layer isn't bun:sqlite-shaped (no .query()/.transaction()
 * combinator -- e.g. node:sqlite, or a project's own dual-runtime Db abstraction)
 * can reuse the exact same engine by writing a small SqliteMigrationRunner adapter,
 * instead of this file needing a new branch or case for every shape. Papyrus's own
 * Db port is one concrete example that could not satisfy the old bun:sqlite-only
 * signature without this split.
 */
import type { Database, DatabaseOptions } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

// bun:sqlite is imported as a type only above -- it's erased at compile time,
// so this module loads fine under Node (e.g. as a pi extension dependency,
// which runs in pi's own Node process, not Bun). The one place we need the
// real constructor (openRawDatabase, below) resolves it lazily and only under
// Bun; everywhere else falls back to node:sqlite. createRequire (rather than
// a bare `require`) is what makes that resolution work from this "type":
// "module" package regardless of which loader executes the .ts directly.
const require = createRequire(import.meta.url);
const isBun = typeof Bun !== "undefined";

/** A single versioned schema migration. Generic over the raw handle its up() mutates directly -- bun:sqlite's Database by default, or another SQLite binding via a SqliteMigrationRunner<Handle> adapter. */
export interface Migration<Handle = Database> {
	/** Target PRAGMA user_version this migration produces. Must be applied in ascending order starting from the current version + 1. */
	version: number;
	up: (handle: Handle) => void;
}

/**
 * Runtime-agnostic port runMigrations needs: read/write the schema version marker and wrap
 * one migration in a transaction. Implement this over any SQLite-shaped store to reuse the
 * generic engine below without modifying it -- see sqliteMigrationRunner for the reference
 * adapter that openSqliteWithPragmas itself uses (works against both the bun:sqlite and
 * node:sqlite handles openRawDatabase can return, since it only touches exec/query/transaction).
 */
export interface SqliteMigrationRunner<Handle> {
	/** The raw handle passed to each Migration's up(). */
	raw: Handle;
	userVersion(): number;
	setUserVersion(version: number): void;
	transaction(fn: () => void): void;
}

export interface OpenSqliteOptions {
	migrations: Migration<Database>[];
	busyTimeoutMs?: number;
	/** Passed through to `new Database(path, databaseOptions)` verbatim -- e.g. { create: true, strict: true }. */
	databaseOptions?: DatabaseOptions;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Applies every not-yet-applied migration (ascending by version) through the given runner,
 * each inside its own transaction, then advances the version marker -- safe to call on every
 * daemon start, since already-applied migrations (per the runner's userVersion()) are
 * skipped. Rejects a version gap (an intermediate migration is missing) or a database newer
 * than every migration the caller knows about (a downgrade -- older code opening a database
 * a newer version created) rather than silently no-op-ing or opening an unrecognized schema.
 */
export function runMigrations<Handle>(runner: SqliteMigrationRunner<Handle>, migrations: Migration<Handle>[]): void {
	const sorted = [...migrations].sort((a, b) => a.version - b.version);
	const targetVersion = sorted.at(-1)?.version ?? 0;
	let current = runner.userVersion();
	if (current > targetVersion) {
		throw new Error(`database schema ${current} is newer than supported ${targetVersion}`);
	}
	for (const migration of sorted) {
		if (migration.version <= current) continue;
		if (migration.version !== current + 1) {
			throw new Error(`migration gap: at version ${current}, next migration targets ${migration.version} (expected ${current + 1})`);
		}
		runner.transaction(() => {
			migration.up(runner.raw);
			runner.setUserVersion(migration.version);
		});
		current = migration.version;
	}
}

function sqliteMigrationRunner(db: Database): SqliteMigrationRunner<Database> {
	return {
		raw: db,
		userVersion: () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
		setUserVersion: (version) => db.exec(`PRAGMA user_version = ${version}`),
		transaction: (fn) => db.transaction(fn)(),
	};
}

/**
 * Opens a SQLite database handle shaped like bun:sqlite's Database --
 * exec(), query(sql).get/all/run(), and transaction(fn) -- which is the only
 * surface this module and its known consumers use. Under Bun that's the real
 * bun:sqlite Database. Everywhere else it's a thin wrapper over Node's
 * built-in node:sqlite (stable enough here; emits an ExperimentalWarning on
 * first use, harmless). `databaseOptions` is bun:sqlite's own option shape
 * (create/strict/safeIntegers/...) and is passed through verbatim on Bun only
 * -- it has no node:sqlite equivalent, so it's silently ignored on the Node
 * path. No current caller sets it, so this hasn't needed to be solved yet;
 * revisit if one does.
 */
function openRawDatabase(path: string, databaseOptions?: DatabaseOptions): Database {
	if (isBun) {
		const bunSqlite = require("bun:sqlite") as typeof import("bun:sqlite");
		return new bunSqlite.Database(path, databaseOptions) as Database;
	}
	const nodeSqlite = require("node:sqlite") as typeof import("node:sqlite");
	const raw = new nodeSqlite.DatabaseSync(path);
	return {
		exec: (sql: string) => raw.exec(sql),
		query: (sql: string) => raw.prepare(sql),
		transaction: (fn: () => void) => () => {
			raw.exec("BEGIN");
			try {
				fn();
				raw.exec("COMMIT");
			} catch (err) {
				raw.exec("ROLLBACK");
				throw err;
			}
		},
	} as unknown as Database;
}

/**
 * Opens (creating parent directories as needed) and migrates a SQLite
 * database -- see openRawDatabase for which runtime backs it. Safe to call on
 * every daemon start: migrations already applied (per PRAGMA user_version)
 * are skipped. Built on the generic runMigrations engine via
 * sqliteMigrationRunner -- see that engine's doc comment for how a different
 * SQLite binding reuses it without editing this function.
 */
export function openSqliteWithPragmas(path: string, options: OpenSqliteOptions): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = openRawDatabase(path, options.databaseOptions);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

	runMigrations(sqliteMigrationRunner(db), options.migrations);

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
