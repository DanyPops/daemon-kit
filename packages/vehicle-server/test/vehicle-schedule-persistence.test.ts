import { describe, expect, it } from "bun:test";
import type { AtomicJsonFsAdapter } from "@danypops/vehicle-core";
import { createFileVehicleSchedulePersistence, type VehicleSchedulePersistedSnapshot } from "../src/vehicle-schedule-persistence.ts";

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

const validSnapshot: VehicleSchedulePersistedSnapshot = {
	version: 1,
	savedAt: 1_000,
	entries: [
		{
			scheduleId: "sched-1",
			owner: "test-owner",
			trigger: { kind: "every", intervalMs: 60_000 },
			action: { kind: "operation", name: "test.tick", version: 1, input: { n: 1 } },
			createdAt: 100,
			nextFireAt: 60_100,
		},
	],
};

describe("createFileVehicleSchedulePersistence", () => {
	it("round-trips a snapshot through save()/load()", async () => {
		const fs = createFakeFs();
		const persistence = createFileVehicleSchedulePersistence({ filePath: "/state/schedules.json", fs });
		await persistence.save(validSnapshot);
		await expect(persistence.load()).resolves.toEqual(validSnapshot);
	});

	it("round-trips an event-action entry too", async () => {
		const fs = createFakeFs();
		const persistence = createFileVehicleSchedulePersistence({ filePath: "/state/schedules.json", fs });
		const snapshot: VehicleSchedulePersistedSnapshot = {
			version: 1,
			savedAt: 1_000,
			entries: [
				{
					scheduleId: "sched-2",
					owner: "test-owner",
					trigger: { kind: "at", at: 5_000 },
					action: { kind: "event", name: "test.announced", version: 1, payload: { hello: "world" } },
					createdAt: 100,
					nextFireAt: 5_000,
				},
			],
		};
		await persistence.save(snapshot);
		await expect(persistence.load()).resolves.toEqual(snapshot);
	});

	it("load() returns undefined when nothing has ever been saved", async () => {
		const fs = createFakeFs();
		const persistence = createFileVehicleSchedulePersistence({ filePath: "/state/schedules.json", fs });
		await expect(persistence.load()).resolves.toBeUndefined();
	});

	it("load() discards a malformed file instead of throwing, and reports it via onCorruptSnapshot", async () => {
		const fs = createFakeFs();
		fs.files.set("/state/schedules.json", JSON.stringify({ not: "a snapshot" }));
		let reported: unknown;
		const persistence = createFileVehicleSchedulePersistence({
			filePath: "/state/schedules.json",
			fs,
			onCorruptSnapshot: (raw) => {
				reported = raw;
			},
		});
		await expect(persistence.load()).resolves.toBeUndefined();
		expect(reported).toEqual({ not: "a snapshot" });
	});

	it("load() discards an entry missing required fields", async () => {
		const fs = createFakeFs();
		fs.files.set("/state/schedules.json", JSON.stringify({ version: 1, savedAt: 1, entries: [{ scheduleId: "x" }] }));
		const persistence = createFileVehicleSchedulePersistence({ filePath: "/state/schedules.json", fs });
		await expect(persistence.load()).resolves.toBeUndefined();
	});
});
