import { describe, expect, it } from "bun:test";
import { initialFireAt, nextFireAtAfterFire, nextFireAtAfterRestore, VehicleScheduleLimitExceeded } from "../src/vehicle-scheduler.ts";

describe("initialFireAt", () => {
	it("a one-shot 'at' trigger fires at its own declared time, independent of now", () => {
		expect(initialFireAt({ kind: "at", at: 5_000 }, 1_000)).toBe(5_000);
	});

	it("a recurring 'every' trigger's first fire is now + intervalMs", () => {
		expect(initialFireAt({ kind: "every", intervalMs: 10_000 }, 1_000)).toBe(11_000);
	});
});

describe("nextFireAtAfterFire", () => {
	it("a one-shot 'at' trigger returns undefined -- remove the entry, never re-arm", () => {
		expect(nextFireAtAfterFire({ kind: "at", at: 5_000 }, 6_000)).toBeUndefined();
	});

	it("a recurring 'every' trigger returns now + intervalMs", () => {
		expect(nextFireAtAfterFire({ kind: "every", intervalMs: 10_000 }, 6_000)).toBe(16_000);
	});
});

describe("nextFireAtAfterRestore", () => {
	it("a one-shot 'at' trigger keeps its original persisted time even if overdue -- fires ASAP, never silently dropped", () => {
		expect(nextFireAtAfterRestore({ kind: "at", at: 500 }, 500, 10_000)).toBe(500);
	});

	it("a recurring 'every' trigger still in the future keeps its persisted next fire time", () => {
		expect(nextFireAtAfterRestore({ kind: "every", intervalMs: 10_000 }, 15_000, 10_000)).toBe(15_000);
	});

	it("a recurring 'every' trigger that fell behind resumes its cadence from now, instead of firing once per missed tick", () => {
		expect(nextFireAtAfterRestore({ kind: "every", intervalMs: 10_000 }, 1_000, 100_000)).toBe(110_000);
	});
});

describe("VehicleScheduleLimitExceeded", () => {
	it("names the owner and the bound in its message", () => {
		const error = new VehicleScheduleLimitExceeded("papyrus", 32);
		expect(error.owner).toBe("papyrus");
		expect(error.max).toBe(32);
		expect(error.message).toContain("papyrus");
		expect(error.message).toContain("32");
	});
});
