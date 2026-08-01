import { describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema, type VehicleOperationBinding } from "@danypops/vehicle-core";
import type { VehicleJobPersistedSnapshot, VehicleJobPersistenceAdapter } from "../src/vehicle-job-persistence.ts";
import { VehicleJobStore } from "../src/vehicle-job-store.ts";
import { VehicleRegistry } from "../src/vehicle-registry.ts";

const passthroughSchema = defineVehicleSchema<Record<string, unknown>>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> }),
});

const LIMITS = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 4_096, maxResponseBytes: 4_096 } as const;

function backgroundOperation(name: string, wakeBudget = { maxCount: 10, maxBytes: 10_000 }) {
	return defineVehicleOperation({
		name,
		version: 1,
		description: "Test background op.",
		input: passthroughSchema,
		output: passthroughSchema,
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		longRunning: true,
		limits: LIMITS,
		background: { supported: true, defaultWakeBudget: wakeBudget, maxWakeBudget: wakeBudget },
	});
}

const liveOnlyOperation = defineVehicleOperation({
	name: "test.live-only",
	version: 1,
	description: "No background capability.",
	input: passthroughSchema,
	output: passthroughSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

/** Exposes resolve/reject and every reportProgress call to the test, instead of racing real timers. */
function deferredJob(name: string, wakeBudget?: { maxCount: number; maxBytes: number }) {
	const operation = backgroundOperation(name, wakeBudget);
	let resolveHandler!: (output: unknown) => void;
	let rejectHandler!: (error: unknown) => void;
	let reportProgress!: (progress: unknown) => void;
	const binding = bindVehicleOperation(operation, () => (context) => {
		reportProgress = context.reportProgress;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			resolveHandler = resolve as (output: unknown) => void;
			rejectHandler = reject;
		});
	});
	return {
		binding,
		resolve: (output: unknown) => resolveHandler(output),
		reject: (error: unknown) => rejectHandler(error),
		progress: (value: unknown) => reportProgress(value),
	};
}

// biome-ignore lint/suspicious/noExplicitAny: a test fixture registering operations of genuinely different Input/Output shapes.
function registryWith(...bindings: VehicleOperationBinding<any, any>[]): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
	for (const binding of bindings) registry.register("test-owner", binding);
	return registry;
}

describe("VehicleJobStore", () => {
	it("submit returns a job id immediately without waiting for the handler", async () => {
		const job = deferredJob("test.submit");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.submit", 1, {});
		expect(typeof jobId).toBe("string");
		expect(store.poll(jobId).status).toBe("running");
		job.resolve({ done: true });
		await Promise.resolve();
	});

	it("poll reflects success once the handler resolves", async () => {
		const job = deferredJob("test.success");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.success", 1, {});
		job.resolve({ answer: 42 });
		await flush();
		expect(store.poll(jobId)).toMatchObject({ status: "succeeded", terminationReason: "succeeded", output: { answer: 42 } });
	});

	it("poll reflects failure with a wire-safe error once the handler rejects", async () => {
		const job = deferredJob("test.failure");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.failure", 1, {});
		job.reject(new Error("boom"));
		await flush();
		const snapshot = store.poll(jobId);
		expect(snapshot.status).toBe("failed");
		expect(snapshot.terminationReason).toBe("failed");
		expect(snapshot.error).toMatchObject({ code: "handler-failed" });
	});

	it("tail replays progress entries with a cursor, and only what's new on a later call", async () => {
		const job = deferredJob("test.tail");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.tail", 1, {});
		job.progress({ step: 1 });
		job.progress({ step: 2 });

		const first = store.tail(jobId);
		expect(first.entries.map((entry) => entry.progress)).toEqual([{ step: 1 }, { step: 2 }]);

		job.progress({ step: 3 });
		const second = store.tail(jobId, first.cursor);
		expect(second.entries.map((entry) => entry.progress)).toEqual([{ step: 3 }]);

		job.resolve({});
		await flush();
	});

	it("cancel aborts a running job's signal and terminates it as canceled even though the handler resolves anyway", async () => {
		const operation = backgroundOperation("test.cancel");
		let signal!: AbortSignal;
		const binding = bindVehicleOperation(operation, () => (context) => {
			signal = context.signal;
			return new Promise((resolve) => {
				context.signal.addEventListener("abort", () => resolve({ finishedAnyway: true }));
			});
		});
		const store = new VehicleJobStore(registryWith(binding));
		const { jobId } = store.submit("test.cancel", 1, {});
		store.cancel(jobId);
		await flush();
		expect(signal.aborted).toBe(true);
		expect(store.poll(jobId)).toMatchObject({ status: "canceled", terminationReason: "canceled" });
	});

	it("cancel is a no-op against an already-terminal job", async () => {
		const job = deferredJob("test.cancel-after-done");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.cancel-after-done", 1, {});
		job.resolve({ ok: true });
		await flush();
		expect(() => store.cancel(jobId)).not.toThrow();
		expect(store.poll(jobId)).toMatchObject({ status: "succeeded" });
	});

	it("a maxLifetimeMs timeout finalizes the job even though the handler never settles", async () => {
		const job = deferredJob("test.timeout");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.timeout", 1, {}, { maxLifetimeMs: 5 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(store.poll(jobId)).toMatchObject({ status: "failed", terminationReason: "timeout" });
	});

	it("finalize is idempotent: a timeout racing a later natural completion keeps the timeout's own outcome", async () => {
		const job = deferredJob("test.race");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.race", 1, {}, { maxLifetimeMs: 5 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		job.resolve({ tooLate: true }); // settles after the timeout already finalized -- must not override it
		await flush();
		expect(store.poll(jobId)).toMatchObject({ status: "failed", terminationReason: "timeout" });
	});

	it("refuses to submit an operation with no background capability", () => {
		const store = new VehicleJobStore(registryWith(bindVehicleOperation(liveOnlyOperation, () => async () => ({}))));
		expect(() => store.submit("test.live-only", 1, {})).toThrow("does not support background execution");
	});

	it("poll/tail/cancel against an unknown job id fail with job-not-found", () => {
		const store = new VehicleJobStore(registryWith(deferredJob("test.unknown").binding));
		expect(() => store.poll("nonexistent")).toThrow("No Vehicle job found");
		expect(() => store.tail("nonexistent")).toThrow("No Vehicle job found");
		expect(() => store.cancel("nonexistent")).toThrow("No Vehicle job found");
	});

	it("clamps a requested wake budget to the operation's own ceiling rather than trusting the caller", async () => {
		const job = deferredJob("test.budget", { maxCount: 2, maxBytes: 10_000 });
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.budget", 1, {}, { wakeBudget: { maxCount: 1_000, maxBytes: 1_000_000 }, notifyMode: "always" });
		job.progress(1);
		job.progress(2);
		job.progress(3); // dropped -- clamped to the descriptor's own maxCount of 2, not the requested 1000
		expect(store.tail(jobId).entries).toHaveLength(2);
		job.resolve({});
		await flush();
	});

	it("refuses an unavailable operation the same way invoke() refuses it", () => {
		const registry = registryWith(deferredJob("test.unavailable").binding);
		registry.setAvailability("test.unavailable", 1, false, "not configured");
		const store = new VehicleJobStore(registry);
		expect(() => store.submit("test.unavailable", 1, {})).toThrow("not configured");
	});

	it("refuses a missing granted permission the same way invoke() refuses it", () => {
		const operation = defineVehicleOperation({
			name: "test.perm",
			version: 1,
			description: "Requires a permission.",
			input: passthroughSchema,
			output: passthroughSchema,
			permissions: ["jobs:run"],
			effect: "read",
			idempotency: { mode: "safe" },
			longRunning: true,
			limits: LIMITS,
			background: {
				supported: true,
				defaultWakeBudget: { maxCount: 10, maxBytes: 1_000 },
				maxWakeBudget: { maxCount: 10, maxBytes: 1_000 },
			},
		});
		const store = new VehicleJobStore(registryWith(bindVehicleOperation(operation, () => async () => ({}))));
		expect(() => store.submit("test.perm", 1, {})).toThrow("requires permissions");
	});
});

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** In-memory stand-in for a real file-backed adapter -- persistence-behavior tests care about what VehicleJobStore writes/restores, not about disk I/O itself (that's createFileVehicleJobPersistence's own test file). */
function memoryPersistence(): VehicleJobPersistenceAdapter & { saved?: VehicleJobPersistedSnapshot; saveCount: number } {
	const adapter = {
		saved: undefined as VehicleJobPersistedSnapshot | undefined,
		saveCount: 0,
		async save(snapshot: VehicleJobPersistedSnapshot) {
			adapter.saved = snapshot;
			adapter.saveCount++;
		},
		async load() {
			return adapter.saved;
		},
	};
	return adapter;
}

describe("VehicleJobStore: steer", () => {
	it("delivers a steer input to a handler that opts in via context.steerInputs", async () => {
		const operation = backgroundOperation("test.steer");
		const received: unknown[] = [];
		const binding = bindVehicleOperation(operation, () => (context) => {
			return (async () => {
				for await (const input of context.steerInputs ?? []) {
					received.push(input);
					if (received.length === 2) return { done: true };
				}
				return { done: true };
			})();
		});
		const store = new VehicleJobStore(registryWith(binding));
		const { jobId } = store.submit("test.steer", 1, {});
		store.steer(jobId, { step: "a" });
		store.steer(jobId, { step: "b" });
		await flush();
		expect(received).toEqual([{ step: "a" }, { step: "b" }]);
		expect(store.poll(jobId).status).toBe("succeeded");
	});

	it("steering does not cancel or otherwise disturb the job -- it keeps running until the handler itself finishes", async () => {
		const job = deferredJob("test.steer-no-cancel");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.steer-no-cancel", 1, {});
		store.steer(jobId, "ping");
		expect(store.poll(jobId).status).toBe("running");
		job.resolve({ ok: true });
		await flush();
		expect(store.poll(jobId).status).toBe("succeeded");
	});

	it("refuses to steer an unknown job id", () => {
		const store = new VehicleJobStore(registryWith(deferredJob("test.steer-unknown").binding));
		expect(() => store.steer("nonexistent", {})).toThrow("No Vehicle job found");
	});

	it("refuses to steer an already-terminal job", async () => {
		const job = deferredJob("test.steer-terminal");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.steer-terminal", 1, {});
		job.resolve({});
		await flush();
		expect(() => store.steer(jobId, "too late")).toThrow("cannot accept new input");
	});

	it("surfaces a full steer queue as a distinct, caller-actionable error rather than silently dropping it", () => {
		const operation = backgroundOperation("test.steer-full");
		const binding = bindVehicleOperation(operation, () => () => new Promise(() => {})); // never reads steerInputs
		const store = new VehicleJobStore(registryWith(binding), { maxSteerQueueSize: 1 });
		const { jobId } = store.submit("test.steer-full", 1, {});
		store.steer(jobId, "one");
		expect(() => store.steer(jobId, "two")).toThrow("steer input queue is full");
	});
});

describe("VehicleJobStore: persistence and restore", () => {
	it("persists a running, then completed, job's state so a fresh store restores it", async () => {
		const job = deferredJob("test.persist");
		const persistence = memoryPersistence();
		const store = new VehicleJobStore(registryWith(job.binding), { persistence });
		const { jobId } = store.submit("test.persist", 1, {});
		job.progress({ step: 1 });
		job.resolve({ answer: 42 });
		await flush();
		await store.flushPersistence();

		const restoredStore = new VehicleJobStore(registryWith(deferredJob("test.persist").binding), { persistence });
		const result = await restoredStore.restore();
		expect(result).toEqual({ restoredCount: 1, orphanedCount: 0 });
		expect(restoredStore.poll(jobId)).toMatchObject({ status: "succeeded", output: { answer: 42 } });
		expect(restoredStore.tail(jobId).entries.map((entry) => entry.progress)).toEqual([{ step: 1 }]);
	});

	it("a job still 'running' when persisted is restored as orphaned -- there is no process left to resume it", async () => {
		const job = deferredJob("test.orphan");
		const persistence = memoryPersistence();
		const store = new VehicleJobStore(registryWith(job.binding), { persistence });
		const { jobId } = store.submit("test.orphan", 1, {});
		await store.flushPersistence(); // never resolved -- simulates the daemon dying mid-job

		const restoredStore = new VehicleJobStore(registryWith(deferredJob("test.orphan").binding), { persistence });
		const result = await restoredStore.restore();
		expect(result).toEqual({ restoredCount: 1, orphanedCount: 1 });
		expect(restoredStore.poll(jobId)).toMatchObject({ status: "failed", terminationReason: "orphaned" });
		expect(restoredStore.poll(jobId).error?.code).toBe("job-orphaned-by-restart");
	});

	it("restore() is a no-op when no persistence adapter is configured", async () => {
		const store = new VehicleJobStore(registryWith(deferredJob("test.no-persistence").binding));
		await expect(store.restore()).resolves.toEqual({ restoredCount: 0, orphanedCount: 0 });
	});

	it("restore() is a no-op when the persistence adapter has nothing saved", async () => {
		const store = new VehicleJobStore(registryWith(deferredJob("test.nothing-saved").binding), { persistence: memoryPersistence() });
		await expect(store.restore()).resolves.toEqual({ restoredCount: 0, orphanedCount: 0 });
	});

	it("a persist failure is reported via onPersistError and does not break the job's own execution", async () => {
		const job = deferredJob("test.persist-fails");
		const errors: unknown[] = [];
		const failingPersistence: VehicleJobPersistenceAdapter = {
			save: async () => {
				throw new Error("disk full");
			},
			load: async () => undefined,
		};
		const store = new VehicleJobStore(registryWith(job.binding), {
			persistence: failingPersistence,
			onPersistError: (error) => errors.push(error),
		});
		const { jobId } = store.submit("test.persist-fails", 1, {});
		job.resolve({ ok: true });
		await flush();
		await store.flushPersistence();
		expect(errors.length).toBeGreaterThan(0);
		expect(store.poll(jobId).status).toBe("succeeded"); // the job itself is unaffected
	});
});

describe("VehicleJobStore: delivery confirmation and retention sweep", () => {
	it("a completed job's result stays retrievable after markDelivered -- delivery just makes it eviction-eligible, not gone", async () => {
		const job = deferredJob("test.delivered");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.delivered", 1, {});
		job.resolve({ ok: true });
		await flush();
		expect(store.poll(jobId).delivered).toBe(false);
		store.markDelivered(jobId);
		expect(store.poll(jobId)).toMatchObject({ delivered: true, status: "succeeded", output: { ok: true } });
	});

	it("markDelivered is idempotent and refuses an unknown job id like every other lookup", async () => {
		const job = deferredJob("test.delivered-idempotent");
		const store = new VehicleJobStore(registryWith(job.binding));
		const { jobId } = store.submit("test.delivered-idempotent", 1, {});
		job.resolve({});
		await flush();
		store.markDelivered(jobId);
		expect(() => store.markDelivered(jobId)).not.toThrow();
		expect(() => store.markDelivered("nonexistent")).toThrow("No Vehicle job found");
	});

	it("an undelivered terminal job is never evicted just for aging past deliveredRetentionMs", async () => {
		let now = 0;
		const kept = deferredJob("test.undelivered-kept");
		const trigger = deferredJob("test.undelivered-kept-trigger");
		const store = new VehicleJobStore(registryWith(kept.binding, trigger.binding), {
			now: () => now,
			deliveredRetentionMs: 10,
			maxRetainedJobs: 100,
		});
		const { jobId } = store.submit("test.undelivered-kept", 1, {});
		kept.resolve({});
		await flush();
		now = 1_000_000; // far past deliveredRetentionMs
		const { jobId: triggerId } = store.submit("test.undelivered-kept-trigger", 1, {});
		trigger.resolve({}); // this job's own finalize() runs a sweep as a side effect, without ever delivering `kept`
		await flush();
		expect(store.poll(jobId).status).toBe("succeeded"); // still present -- never delivered, so never eviction-eligible
		expect(store.poll(triggerId).status).toBe("succeeded");
	});

	it("a delivered job becomes eviction-eligible once past deliveredRetentionMs, on the next sweep", async () => {
		let now = 0;
		const job = deferredJob("test.sweep-by-age");
		const store = new VehicleJobStore(registryWith(job.binding), { now: () => now, deliveredRetentionMs: 10, maxRetainedJobs: 100 });
		const { jobId } = store.submit("test.sweep-by-age", 1, {});
		job.resolve({});
		await flush();
		store.markDelivered(jobId); // age 0 at delivery time -- not evicted yet
		expect(store.poll(jobId).status).toBe("succeeded");
		now = 1_000; // now well past deliveredRetentionMs
		store.markDelivered(jobId); // idempotent for the flag itself, but still re-runs the sweep against the new `now`
		expect(() => store.poll(jobId)).toThrow("No Vehicle job found");
	});

	it("evicts down to maxRetainedJobs, preferring delivered jobs oldest-first, once the cap is exceeded", async () => {
		let now = 0;
		const jobs = [deferredJob("test.cap-1"), deferredJob("test.cap-2"), deferredJob("test.cap-3"), deferredJob("test.cap-4")];
		const store = new VehicleJobStore(registryWith(...jobs.map((job) => job.binding)), {
			now: () => now,
			maxRetainedJobs: 3,
			deliveredRetentionMs: 1_000_000_000,
		});

		const ids: string[] = [];
		for (const [index, job] of jobs.slice(0, 3).entries()) {
			now = index * 10;
			ids.push(store.submit(`test.cap-${index + 1}`, 1, {}).jobId);
			job.resolve({ index });
			await flush(); // settles (and sweeps) before the next submit, so each record gets a distinct, ordered updatedAt
		}
		// Cap is 3 and exactly 3 terminal jobs exist -- nothing evicted yet.
		store.markDelivered(ids[0]!);
		store.markDelivered(ids[1]!);
		expect(store.poll(ids[0]!).status).toBe("succeeded");

		now = 100;
		const fourthId = store.submit("test.cap-4", 1, {}).jobId;
		jobs[3]!.resolve({ index: 3 });
		await flush(); // 4 terminal jobs now exist against a cap of 3 -- finalize()'s own sweep must evict one

		// ids[2] was never delivered, so it's protected; the oldest *delivered* job (ids[0]) is evicted instead.
		expect(() => store.poll(ids[0]!)).toThrow("No Vehicle job found");
		expect(store.poll(ids[1]!).status).toBe("succeeded");
		expect(store.poll(ids[2]!).status).toBe("succeeded");
		expect(store.poll(fourthId).status).toBe("succeeded");
	});
});
