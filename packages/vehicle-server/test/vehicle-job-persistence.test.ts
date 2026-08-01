import { describe, expect, it } from "bun:test";
import type { AtomicJsonFsAdapter } from "@danypops/vehicle-core";
import { createFileVehicleJobPersistence, type VehicleJobPersistedSnapshot } from "../src/vehicle-job-persistence.ts";

function createFakeFs(): AtomicJsonFsAdapter & { readonly files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		async writeFile(path, data) {
			files.set(path, data);
		},
		async rename(oldPath, newPath) {
			const data = files.get(oldPath);
			if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			files.set(newPath, data);
			files.delete(oldPath);
		},
		async unlink(path) {
			files.delete(path);
		},
		async readFile(path) {
			const data = files.get(path);
			if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return data;
		},
	};
}

const validSnapshot: VehicleJobPersistedSnapshot = {
	version: 1,
	savedAt: 1_000,
	jobs: [
		{
			jobId: "job-1",
			operationName: "test.op",
			operationVersion: 1,
			status: "succeeded",
			createdAt: 100,
			updatedAt: 200,
			instanceToken: "instance-a",
			delivered: false,
			terminationReason: "succeeded",
			output: { ok: true },
			wakeEntries: [{ seq: 1, at: 150, progress: "step 1" }],
		},
	],
};

describe("createFileVehicleJobPersistence", () => {
	it("round-trips a snapshot through save()/load()", async () => {
		const fs = createFakeFs();
		const persistence = createFileVehicleJobPersistence({ filePath: "/state/jobs.json", fs });
		await persistence.save(validSnapshot);
		await expect(persistence.load()).resolves.toEqual(validSnapshot);
	});

	it("load() returns undefined when nothing has ever been saved", async () => {
		const fs = createFakeFs();
		const persistence = createFileVehicleJobPersistence({ filePath: "/state/jobs.json", fs });
		await expect(persistence.load()).resolves.toBeUndefined();
	});

	it("load() discards a malformed file instead of throwing, and reports it via onCorruptSnapshot", async () => {
		const fs = createFakeFs();
		fs.files.set("/state/jobs.json", JSON.stringify({ not: "a snapshot" }));
		let reported: unknown;
		const persistence = createFileVehicleJobPersistence({
			filePath: "/state/jobs.json",
			fs,
			onCorruptSnapshot: (raw) => {
				reported = raw;
			},
		});
		await expect(persistence.load()).resolves.toBeUndefined();
		expect(reported).toEqual({ not: "a snapshot" });
	});

	it("load() discards a job record missing required fields", async () => {
		const fs = createFakeFs();
		fs.files.set("/state/jobs.json", JSON.stringify({ version: 1, savedAt: 1, jobs: [{ jobId: "x" }] }));
		const persistence = createFileVehicleJobPersistence({ filePath: "/state/jobs.json", fs });
		await expect(persistence.load()).resolves.toBeUndefined();
	});
});
