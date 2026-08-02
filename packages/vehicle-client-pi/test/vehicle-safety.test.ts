import { describe, expect, test } from "bun:test";
import type { AtomicJsonFsAdapter } from "@danypops/vehicle-core";
import {
	classifyVehicleOperationSafety,
	createFileVehicleSafetyPersistence,
	type VehicleSafetyPersistedSnapshot,
	VehicleSafetyPolicyStore,
} from "../src/vehicle-safety.ts";

describe("classifyVehicleOperationSafety", () => {
	test("blocked when permissions aren't satisfied, no override, no matter the effect", () => {
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: false, effect: "read" })).toBe("blocked");
	});

	test("allow for a read effect with satisfied permissions, using the default gated-effect set", () => {
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: true, effect: "read" })).toBe("allow");
	});

	test("ask for a destructive effect with satisfied permissions, using the default gated-effect set (DEFAULT_APPROVAL_EFFECTS)", () => {
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: true, effect: "destructive" })).toBe("ask");
	});

	test("ask for open-world too, matching DEFAULT_APPROVAL_EFFECTS", () => {
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: true, effect: "open-world" })).toBe("ask");
	});

	test("respects a caller-supplied requireApprovalForEffects mirroring a non-default server policy", () => {
		expect(
			classifyVehicleOperationSafety({
				permissionsSatisfied: true,
				effect: "external-write",
				requireApprovalForEffects: new Set(["external-write"]),
			}),
		).toBe("ask");
		// destructive is NOT in this caller's mirrored set, so it's not gated here
		expect(
			classifyVehicleOperationSafety({
				permissionsSatisfied: true,
				effect: "destructive",
				requireApprovalForEffects: new Set(["external-write"]),
			}),
		).toBe("allow");
	});

	test("an explicit override always wins, even over a permission-based block -- a human's own /safety decision", () => {
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: false, effect: "read", override: "allow" })).toBe("allow");
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: false, effect: "read", override: "ask" })).toBe("ask");
	});

	test("an explicit override also wins over the effect-level default", () => {
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: true, effect: "destructive", override: "allow" })).toBe("allow");
		expect(classifyVehicleOperationSafety({ permissionsSatisfied: true, effect: "read", override: "blocked" })).toBe("blocked");
	});
});

describe("VehicleSafetyPolicyStore", () => {
	test("restore() with no persistence adapter starts empty", async () => {
		const store = await VehicleSafetyPolicyStore.restore();
		expect(store.list()).toEqual([]);
		expect(store.get("papyrus", "issues.write")).toBeUndefined();
	});

	test("set() then get() round-trips", async () => {
		const store = await VehicleSafetyPolicyStore.restore();
		await store.set("papyrus", "issues.write", "blocked");
		expect(store.get("papyrus", "issues.write")).toBe("blocked");
		// a different vehicle or operation is unaffected
		expect(store.get("tickets", "issues.write")).toBeUndefined();
		expect(store.get("papyrus", "issues.read")).toBeUndefined();
	});

	test("set() again for the same vehicle+operation replaces, never duplicates", async () => {
		const store = await VehicleSafetyPolicyStore.restore();
		await store.set("papyrus", "issues.write", "ask");
		await store.set("papyrus", "issues.write", "blocked");
		expect(store.get("papyrus", "issues.write")).toBe("blocked");
		expect(store.list()).toHaveLength(1);
	});

	test("clear() removes an override", async () => {
		const store = await VehicleSafetyPolicyStore.restore();
		await store.set("papyrus", "issues.write", "blocked");
		await store.clear("papyrus", "issues.write");
		expect(store.get("papyrus", "issues.write")).toBeUndefined();
	});

	test("clear() on an already-absent override is a no-op, not an error", async () => {
		const store = await VehicleSafetyPolicyStore.restore();
		await expect(store.clear("papyrus", "issues.write")).resolves.toBeUndefined();
	});
});

function inMemoryFsAdapter(): AtomicJsonFsAdapter & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		async writeFile(path, data) {
			files.set(path, data);
		},
		async rename(oldPath, newPath) {
			const data = files.get(oldPath);
			if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			files.delete(oldPath);
			files.set(newPath, data);
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

describe("createFileVehicleSafetyPersistence + VehicleSafetyPolicyStore", () => {
	test("load() on a never-written file returns undefined", async () => {
		const persistence = createFileVehicleSafetyPersistence({ filePath: "/safety.json", fs: inMemoryFsAdapter() });
		expect(await persistence.load()).toBeUndefined();
	});

	test("a set() survives a fresh restore() against the same persistence adapter", async () => {
		const fs = inMemoryFsAdapter();
		const persistence = createFileVehicleSafetyPersistence({ filePath: "/safety.json", fs });
		const store = await VehicleSafetyPolicyStore.restore(persistence);
		await store.set("papyrus", "issues.write", "blocked");

		const restored = await VehicleSafetyPolicyStore.restore(persistence);
		expect(restored.get("papyrus", "issues.write")).toBe("blocked");
	});

	test("a corrupt/foreign file on disk is discarded, restoring empty, and reports via onCorruptSnapshot", async () => {
		const fs = inMemoryFsAdapter();
		fs.files.set("/safety.json", JSON.stringify({ not: "a real snapshot" }));
		let reported: unknown;
		const persistence = createFileVehicleSafetyPersistence({
			filePath: "/safety.json",
			fs,
			onCorruptSnapshot: (raw) => {
				reported = raw;
			},
		});
		const store = await VehicleSafetyPolicyStore.restore(persistence);
		expect(store.list()).toEqual([]);
		expect(reported).toEqual({ not: "a real snapshot" });
	});

	test("a real snapshot round-trips through JSON exactly", async () => {
		const fs = inMemoryFsAdapter();
		const persistence = createFileVehicleSafetyPersistence({ filePath: "/safety.json", fs });
		await persistence.save({
			version: 1,
			savedAt: 1000,
			overrides: [{ vehicleName: "papyrus", operationName: "issues.write", state: "ask" }],
		} satisfies VehicleSafetyPersistedSnapshot);
		expect(await persistence.load()).toEqual({
			version: 1,
			savedAt: 1000,
			overrides: [{ vehicleName: "papyrus", operationName: "issues.write", state: "ask" }],
		});
	});
});
