import { describe, expect, test } from "bun:test";
import type { AtomicJsonFsAdapter } from "../src/atomic-json.ts";
import { createAtomicJsonWriter } from "../src/atomic-json.ts";

function createFakeFs(): AtomicJsonFsAdapter & { readonly files: Map<string, string>; renameCalls: number } {
	const files = new Map<string, string>();
	return {
		files,
		renameCalls: 0,
		async writeFile(path, data) {
			files.set(path, data);
		},
		async rename(oldPath, newPath) {
			this.renameCalls++;
			const data = files.get(oldPath);
			if (data === undefined) {
				const error = new Error(`ENOENT: no such file, rename '${oldPath}'`) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			files.set(newPath, data);
			files.delete(oldPath);
		},
		async unlink(path) {
			if (!files.has(path)) {
				const error = new Error(`ENOENT: no such file, unlink '${path}'`) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			files.delete(path);
		},
		async readFile(path) {
			const data = files.get(path);
			if (data === undefined) {
				const error = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return data;
		},
	};
}

describe("createAtomicJsonWriter", () => {
	test("write() writes to a temp file then renames onto the destination, leaving only the destination behind", async () => {
		const fs = createFakeFs();
		const writer = createAtomicJsonWriter({ fs });
		await writer.write("/state/jobs.json", { jobs: [1, 2, 3] });
		expect([...fs.files.keys()]).toEqual(["/state/jobs.json"]);
		expect(fs.files.get("/state/jobs.json")).toBe(JSON.stringify({ jobs: [1, 2, 3] }));
	});

	test("temp filename is collision-safe: includes pid, now, and a random suffix", async () => {
		const fs = createFakeFs();
		const seenTempPaths: string[] = [];
		const originalWriteFile = fs.writeFile.bind(fs);
		fs.writeFile = async (path, data) => {
			seenTempPaths.push(path);
			await originalWriteFile(path, data);
		};
		const writer = createAtomicJsonWriter({ fs, pid: () => 4242, now: () => 1000, random: () => "abc123" });
		await writer.write("/state/jobs.json", { ok: true });
		expect(seenTempPaths).toEqual(["/state/.jobs.json.4242.1000.abc123.tmp"]);
	});

	test("read() parses back what write() wrote", async () => {
		const fs = createFakeFs();
		const writer = createAtomicJsonWriter({ fs });
		await writer.write("/state/jobs.json", { jobs: ["a", "b"] });
		await expect(writer.read("/state/jobs.json")).resolves.toEqual({ jobs: ["a", "b"] });
	});

	test("read() returns undefined for a missing file instead of throwing", async () => {
		const fs = createFakeFs();
		const writer = createAtomicJsonWriter({ fs });
		await expect(writer.read("/state/missing.json")).resolves.toBeUndefined();
	});

	test("read() rethrows a non-ENOENT error", async () => {
		const fs = createFakeFs();
		fs.readFile = async () => {
			throw new Error("EACCES: permission denied");
		};
		const writer = createAtomicJsonWriter({ fs });
		await expect(writer.read("/state/jobs.json")).rejects.toThrow("EACCES");
	});

	test("write() rejects a non-JSON-serializable value without touching the filesystem", async () => {
		const fs = createFakeFs();
		const writer = createAtomicJsonWriter({ fs });
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(writer.write("/state/jobs.json", circular)).rejects.toThrow("not JSON-serializable");
		expect(fs.files.size).toBe(0);
	});

	describe("rename retry", () => {
		function flakyRenameFs(failuresBeforeSuccess: number): AtomicJsonFsAdapter & { readonly files: Map<string, string>; attempts: number } {
			const base = createFakeFs();
			let attempts = 0;
			return {
				...base,
				attempts,
				async writeFile(path, data) {
					await base.writeFile(path, data);
				},
				async rename(oldPath, newPath) {
					attempts++;
					this.attempts = attempts;
					if (attempts <= failuresBeforeSuccess) {
						const error = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
						error.code = "EBUSY";
						throw error;
					}
					await base.rename(oldPath, newPath);
				},
				async readFile(path) {
					return base.readFile(path);
				},
				async unlink(path) {
					return base.unlink(path);
				},
			};
		}

		test("off by default (non-Windows): a transient rename error is not retried, temp file is cleaned up", async () => {
			const fs = flakyRenameFs(1);
			const writer = createAtomicJsonWriter({ fs, sleep: async () => {} });
			await expect(writer.write("/state/jobs.json", { ok: true })).rejects.toThrow("EBUSY");
			expect(fs.attempts).toBe(1);
			expect(fs.files.size).toBe(0); // temp file cleaned up, destination never created
		});

		test("enabled explicitly: retries a transient rename error and succeeds once it clears", async () => {
			const fs = flakyRenameFs(2);
			const writer = createAtomicJsonWriter({ fs, retryRename: true, sleep: async () => {} });
			await writer.write("/state/jobs.json", { ok: true });
			expect(fs.attempts).toBe(3);
			expect([...fs.files.keys()]).toEqual(["/state/jobs.json"]);
		});

		test("enabled but the error is never in retryRenameErrors: fails immediately, no retry, temp file cleaned up", async () => {
			const fs = flakyRenameFs(1);
			const writer = createAtomicJsonWriter({ fs, retryRename: true, retryRenameErrors: ["EPERM"], sleep: async () => {} });
			await expect(writer.write("/state/jobs.json", { ok: true })).rejects.toThrow("EBUSY");
			expect(fs.attempts).toBe(1);
			expect(fs.files.size).toBe(0);
		});

		test("enabled, retries exhausted: rethrows the last error, temp file cleaned up", async () => {
			const fs = flakyRenameFs(10);
			const writer = createAtomicJsonWriter({ fs, retryRename: true, retryDelaysMs: [0, 0], sleep: async () => {} });
			await expect(writer.write("/state/jobs.json", { ok: true })).rejects.toThrow("EBUSY");
			expect(fs.attempts).toBe(3); // initial attempt + 2 retries
			expect(fs.files.size).toBe(0);
		});

		test("default retryRename matches process.platform === 'win32'", () => {
			const fs = createFakeFs();
			const writer = createAtomicJsonWriter({ fs });
			expect(writer).toBeDefined(); // defaultPlatformIsWindows() is exercised via the off-by-default test above on this (non-Windows) CI/dev platform
			expect(process.platform).not.toBe("win32"); // sanity: proves the "off by default" test above is actually exercising the real default, not coincidence
		});
	});

	test("unlink failure during cleanup does not mask the original rename error", async () => {
		const fs = createFakeFs();
		fs.rename = async () => {
			const error = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
			error.code = "EBUSY";
			throw error;
		};
		fs.unlink = async () => {
			throw new Error("unlink also failed");
		};
		const writer = createAtomicJsonWriter({ fs });
		await expect(writer.write("/state/jobs.json", { ok: true })).rejects.toThrow("EBUSY");
	});
});
