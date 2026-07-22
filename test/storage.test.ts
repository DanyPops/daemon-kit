import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint, openSqliteWithPragmas, optimize } from "../src/storage.ts";

describe("openSqliteWithPragmas", () => {
	it("applies migrations in order and is safe to call again (no re-application)", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-storage-"));
		const path = join(dir, "sub", "db.sqlite");
		try {
			const applied: number[] = [];
			const db1 = openSqliteWithPragmas(path, {
				migrations: [
					{ version: 1, up: (d) => { d.exec("CREATE TABLE t (x INTEGER)"); applied.push(1); } },
					{ version: 2, up: (d) => { d.exec("ALTER TABLE t ADD COLUMN y TEXT"); applied.push(2); } },
				],
			});
			db1.query("INSERT INTO t (x, y) VALUES (1, 'a')").run();
			db1.close();

			// Re-opening with the same migrations must not re-run them.
			const db2 = openSqliteWithPragmas(path, {
				migrations: [
					{ version: 1, up: (d) => { d.exec("CREATE TABLE t (x INTEGER)"); applied.push(1); } },
					{ version: 2, up: (d) => { d.exec("ALTER TABLE t ADD COLUMN y TEXT"); applied.push(2); } },
				],
			});
			expect(applied).toEqual([1, 2]); // only from the first open
			expect(db2.query("SELECT x, y FROM t").get()).toEqual({ x: 1, y: "a" });
			db2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("applies only new migrations when reopened with additional ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-storage-"));
		const path = join(dir, "db.sqlite");
		try {
			const db1 = openSqliteWithPragmas(path, { migrations: [{ version: 1, up: (d) => d.exec("CREATE TABLE t (x INTEGER)") }] });
			db1.close();
			const db2 = openSqliteWithPragmas(path, {
				migrations: [
					{ version: 1, up: (d) => d.exec("CREATE TABLE t (x INTEGER)") },
					{ version: 2, up: (d) => d.exec("ALTER TABLE t ADD COLUMN y TEXT DEFAULT 'z'") },
				],
			});
			db2.query("INSERT INTO t (x) VALUES (1)").run();
			expect(db2.query("SELECT y FROM t").get()).toEqual({ y: "z" });
			db2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a migration list with a gap", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-storage-"));
		const path = join(dir, "db.sqlite");
		try {
			expect(() =>
				openSqliteWithPragmas(path, {
					migrations: [{ version: 1, up: (d) => d.exec("CREATE TABLE t (x INTEGER)") }, { version: 3, up: () => {} }],
				}),
			).toThrow(/migration gap/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sets foreign_keys, busy_timeout, and journal_mode=WAL for a file-backed database", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-storage-"));
		const path = join(dir, "db.sqlite");
		try {
			const db = openSqliteWithPragmas(path, { migrations: [], busyTimeoutMs: 1234 });
			expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
			expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(1234);
			expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
			checkpoint(db);
			optimize(db);
			db.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips journal_mode=WAL for :memory: databases", () => {
		const db = openSqliteWithPragmas(":memory:", { migrations: [] });
		expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).not.toBe("wal");
		db.close();
	});
});
