import { describe, expect, it } from "bun:test";
import {
	createStaticVehicleJobWakeLog,
	resolveVehicleJobTerminationReason,
	selectVehicleJobsForEviction,
	VehicleJobSteerChannel,
	VehicleJobWakeLog,
	vehicleJobIdentityMatches,
} from "../src/vehicle-jobs.ts";

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

	it("prefers orphaned over failed and succeeded, but loses to canceled and timeout", () => {
		expect(resolveVehicleJobTerminationReason(["succeeded", "orphaned"])).toBe("orphaned");
		expect(resolveVehicleJobTerminationReason(["failed", "orphaned"])).toBe("orphaned");
		expect(resolveVehicleJobTerminationReason(["orphaned", "canceled"])).toBe("canceled");
		expect(resolveVehicleJobTerminationReason(["orphaned", "timeout"])).toBe("timeout");
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

describe("createStaticVehicleJobWakeLog", () => {
	it("replays a fixed entry list with the same since()/cursor contract as a live VehicleJobWakeLog", () => {
		const reader = createStaticVehicleJobWakeLog([
			{ seq: 1, at: 100, progress: "a" },
			{ seq: 2, at: 200, progress: "b" },
			{ seq: 3, at: 300, progress: "c" },
		]);
		expect(reader.cursor).toBe(3);
		expect(reader.since(0).map((entry) => entry.progress)).toEqual(["a", "b", "c"]);
		expect(reader.since(1).map((entry) => entry.progress)).toEqual(["b", "c"]);
		expect(reader.since(3)).toEqual([]);
	});

	it("sorts out-of-order input by seq before computing cursor", () => {
		const reader = createStaticVehicleJobWakeLog([
			{ seq: 2, at: 200, progress: "b" },
			{ seq: 1, at: 100, progress: "a" },
		]);
		expect(reader.cursor).toBe(2);
		expect(reader.since(0).map((entry) => entry.progress)).toEqual(["a", "b"]);
	});

	it("an empty entry list has cursor 0", () => {
		expect(createStaticVehicleJobWakeLog([]).cursor).toBe(0);
	});
});

describe("vehicleJobIdentityMatches", () => {
	it("matches only an identical instance token", () => {
		expect(vehicleJobIdentityMatches("token-a", "token-a")).toBe(true);
		expect(vehicleJobIdentityMatches("token-a", "token-b")).toBe(false);
	});
});

describe("VehicleJobSteerChannel", () => {
	it("delivers a push directly to a waiting reader without buffering it", async () => {
		const channel = new VehicleJobSteerChannel(1);
		const iterator = channel[Symbol.asyncIterator]();
		const pending = iterator.next();
		expect(channel.push("hello")).toEqual({ accepted: true });
		await expect(pending).resolves.toEqual({ value: "hello", done: false });
	});

	it("buffers a push made before any reader is iterating, up to maxQueueSize", async () => {
		const channel = new VehicleJobSteerChannel(2);
		expect(channel.push("a")).toEqual({ accepted: true });
		expect(channel.push("b")).toEqual({ accepted: true });
		expect(channel.push("c")).toEqual({ accepted: false, dropReason: "queue-full" });

		const iterator = channel[Symbol.asyncIterator]();
		await expect(iterator.next()).resolves.toEqual({ value: "a", done: false });
		await expect(iterator.next()).resolves.toEqual({ value: "b", done: false });
	});

	it("close() ends every pending and future iteration, and refuses further pushes", async () => {
		const channel = new VehicleJobSteerChannel(4);
		const iterator = channel[Symbol.asyncIterator]();
		const pending = iterator.next();
		channel.close();
		await expect(pending).resolves.toEqual({ value: undefined, done: true });
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		expect(channel.push("too late")).toEqual({ accepted: false, dropReason: "channel-closed" });
	});

	it("close() is idempotent", () => {
		const channel = new VehicleJobSteerChannel();
		channel.close();
		expect(() => channel.close()).not.toThrow();
	});

	it("a for-await consumer sees every pushed value in order, then ends cleanly on close()", async () => {
		const channel = new VehicleJobSteerChannel();
		const seen: unknown[] = [];
		const consumer = (async () => {
			for await (const value of channel) seen.push(value);
		})();
		channel.push(1);
		channel.push(2);
		await Promise.resolve();
		channel.close();
		await consumer;
		expect(seen).toEqual([1, 2]);
	});
});

describe("selectVehicleJobsForEviction", () => {
	it("never evicts a running job, regardless of the cap", () => {
		const evicted = selectVehicleJobsForEviction([{ jobId: "a", status: "running", delivered: false, updatedAt: 0 }], {
			maxRetainedJobs: 0,
			deliveredRetentionMs: 0,
			now: 1_000,
		});
		expect(evicted).toEqual([]);
	});

	it("evicts a delivered terminal job once it's past deliveredRetentionMs, even under the cap", () => {
		const evicted = selectVehicleJobsForEviction(
			[
				{ jobId: "old", status: "succeeded", delivered: true, updatedAt: 0 },
				{ jobId: "new", status: "succeeded", delivered: true, updatedAt: 900 },
			],
			{ maxRetainedJobs: 100, deliveredRetentionMs: 1_000, now: 1_000 },
		);
		expect(evicted).toEqual(["old"]);
	});

	it("prefers evicting delivered jobs, oldest first, once over the cap", () => {
		const evicted = selectVehicleJobsForEviction(
			[
				{ jobId: "undelivered", status: "succeeded", delivered: false, updatedAt: 0 },
				{ jobId: "delivered-older", status: "succeeded", delivered: true, updatedAt: 100 },
				{ jobId: "delivered-newer", status: "succeeded", delivered: true, updatedAt: 200 },
			],
			{ maxRetainedJobs: 2, deliveredRetentionMs: 1_000_000, now: 1_000 },
		);
		expect(evicted).toEqual(["delivered-older"]);
	});

	it("falls back to evicting an undelivered terminal job, oldest first, only once no delivered job remains", () => {
		const evicted = selectVehicleJobsForEviction(
			[
				{ jobId: "undelivered-older", status: "failed", delivered: false, updatedAt: 0 },
				{ jobId: "undelivered-newer", status: "failed", delivered: false, updatedAt: 100 },
			],
			{ maxRetainedJobs: 1, deliveredRetentionMs: 1_000_000, now: 1_000 },
		);
		expect(evicted).toEqual(["undelivered-older"]);
	});

	it("does nothing when at or under the cap and nothing is past its delivered-retention window", () => {
		const evicted = selectVehicleJobsForEviction(
			[
				{ jobId: "a", status: "succeeded", delivered: true, updatedAt: 900 },
				{ jobId: "b", status: "running", delivered: false, updatedAt: 950 },
			],
			{ maxRetainedJobs: 10, deliveredRetentionMs: 1_000, now: 1_000 },
		);
		expect(evicted).toEqual([]);
	});
});
