import { describe, expect, it } from "bun:test";
import { resolveVehicleJobTerminationReason, VehicleJobWakeLog } from "../src/vehicle-jobs.ts";

describe("resolveVehicleJobTerminationReason", () => {
	it("throws for an empty candidate list", () => {
		expect(() => resolveVehicleJobTerminationReason([])).toThrow("at least one candidate");
	});

	it("returns the sole candidate when only one is given", () => {
		expect(resolveVehicleJobTerminationReason(["succeeded"])).toBe("succeeded");
		expect(resolveVehicleJobTerminationReason(["failed"])).toBe("failed");
	});

	it("prefers canceled over every other candidate, even a completed handler racing a cancel request", () => {
		expect(resolveVehicleJobTerminationReason(["succeeded", "canceled"])).toBe("canceled");
		expect(resolveVehicleJobTerminationReason(["failed", "canceled"])).toBe("canceled");
		expect(resolveVehicleJobTerminationReason(["timeout", "canceled"])).toBe("canceled");
	});

	it("prefers timeout over failed and succeeded when no cancel was requested", () => {
		expect(resolveVehicleJobTerminationReason(["succeeded", "timeout"])).toBe("timeout");
		expect(resolveVehicleJobTerminationReason(["failed", "timeout"])).toBe("timeout");
	});

	it("prefers failed over succeeded", () => {
		expect(resolveVehicleJobTerminationReason(["succeeded", "failed"])).toBe("failed");
	});
});

describe("VehicleJobWakeLog", () => {
	it("accepts every progress notification in 'always' mode, assigning increasing sequence numbers", () => {
		const log = new VehicleJobWakeLog({ notifyMode: "always", budget: { maxCount: 10, maxBytes: 10_000 } });
		expect(log.append({ step: 1 })).toMatchObject({ accepted: true, entry: { seq: 1 } });
		expect(log.append({ step: 1 })).toMatchObject({ accepted: true, entry: { seq: 2 } }); // identical value, still kept in "always" mode
		expect(log.append({ step: 2 })).toMatchObject({ accepted: true, entry: { seq: 3 } });
		expect(log.cursor).toBe(3);
	});

	it("since() replays only entries after the given cursor", () => {
		const log = new VehicleJobWakeLog({ notifyMode: "always", budget: { maxCount: 10, maxBytes: 10_000 } });
		log.append("a");
		log.append("b");
		log.append("c");
		expect(log.since(0).map((entry) => entry.progress)).toEqual(["a", "b", "c"]);
		expect(log.since(1).map((entry) => entry.progress)).toEqual(["b", "c"]);
		expect(log.since(3)).toEqual([]);
	});

	it("'transition' mode drops a value identical to the immediately preceding one", () => {
		const log = new VehicleJobWakeLog({ notifyMode: "transition", budget: { maxCount: 10, maxBytes: 10_000 } });
		expect(log.append({ status: "running" }).accepted).toBe(true);
		expect(log.append({ status: "running" })).toEqual({ accepted: false, dropReason: "deduplicated-transition" });
		expect(log.append({ status: "done" }).accepted).toBe(true);
		expect(log.append({ status: "done" })).toEqual({ accepted: false, dropReason: "deduplicated-transition" });
		expect(log.append({ status: "running" }).accepted).toBe(true); // a genuine transition back is kept, not just monotonic dedup
		expect(log.since(0)).toHaveLength(3);
	});

	it("'first-only' mode keeps just the first accepted entry and drops every one after", () => {
		const log = new VehicleJobWakeLog({ notifyMode: "first-only", budget: { maxCount: 10, maxBytes: 10_000 } });
		expect(log.append("a")).toMatchObject({ accepted: true });
		expect(log.append("b")).toEqual({ accepted: false, dropReason: "superseded-by-first-only" });
		expect(log.append("c")).toEqual({ accepted: false, dropReason: "superseded-by-first-only" });
		expect(log.since(0).map((entry) => entry.progress)).toEqual(["a"]);
	});

	it("enforces a hard count budget", () => {
		const log = new VehicleJobWakeLog({ notifyMode: "always", budget: { maxCount: 2, maxBytes: 10_000 } });
		expect(log.append(1).accepted).toBe(true);
		expect(log.append(2).accepted).toBe(true);
		expect(log.append(3)).toEqual({ accepted: false, dropReason: "count-budget-exhausted" });
		expect(log.since(0)).toHaveLength(2);
	});

	it("enforces a hard byte budget", () => {
		const log = new VehicleJobWakeLog({ notifyMode: "always", budget: { maxCount: 100, maxBytes: 10 } });
		expect(log.append("short").accepted).toBe(true); // "short" serializes to `"short"` -- 7 bytes
		expect(log.append("nope")).toEqual({ accepted: false, dropReason: "byte-budget-exhausted" });
	});

	it("throws for a non-JSON-serializable progress value instead of silently dropping it", () => {
		const log = new VehicleJobWakeLog({ notifyMode: "always", budget: { maxCount: 10, maxBytes: 10_000 } });
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => log.append(circular)).toThrow("not JSON-serializable");
	});

	it("uses an injected clock for entry timestamps", () => {
		let now = 1_000;
		const log = new VehicleJobWakeLog({ notifyMode: "always", budget: { maxCount: 10, maxBytes: 10_000 }, now: () => now });
		expect(log.append("a").entry?.at).toBe(1_000);
		now = 2_000;
		expect(log.append("b").entry?.at).toBe(2_000);
	});
});
