import { describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema, type VehicleOperationBinding } from "@danypops/vehicle-core";
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
