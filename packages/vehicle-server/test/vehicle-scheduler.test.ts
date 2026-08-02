import { describe, expect, it } from "bun:test";
import {
	bindVehicleOperation,
	defineVehicleEvent,
	defineVehicleOperation,
	defineVehicleSchema,
	VehicleScheduleLimitExceeded,
} from "@danypops/vehicle-core";
import { VehicleRegistry } from "../src/vehicle-registry.ts";
import { VehicleScheduler } from "../src/vehicle-scheduler.ts";

const LIMITS = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

const inputSchema = defineVehicleSchema<{ n: number }>({
	jsonSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
	safeParse: (value) =>
		typeof value === "object" && value !== null && typeof (value as { n?: unknown }).n === "number"
			? { success: true, value: value as { n: number } }
			: { success: false, issues: [{ path: [], message: "n must be a number" }] },
});
const outputSchema = defineVehicleSchema<{ n: number }>({
	jsonSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
	safeParse: (value) => ({ success: true, value: value as { n: number } }),
});

function registryWithTickOperation(onTick: (n: number) => void): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
	const Tick = defineVehicleOperation({
		name: "test.tick",
		version: 1,
		description: "Records a tick.",
		input: inputSchema,
		output: outputSchema,
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		"tick-provider",
		bindVehicleOperation(Tick, () => async ({ input }) => {
			onTick(input.n);
			return input;
		}),
	);
	return registry;
}

const Announced = defineVehicleEvent<{ n: number }>({
	name: "test.announced",
	version: 1,
	description: "A test event.",
	payload: outputSchema,
	maxPayloadBytes: 1_024,
});

async function wait(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VehicleScheduler", () => {
	it("a one-shot 'at' schedule invokes the declared operation once, after the delay elapses", async () => {
		const ticks: number[] = [];
		const registry = registryWithTickOperation((n) => ticks.push(n));
		const scheduler = new VehicleScheduler(registry);

		scheduler.schedule(
			"owner-1",
			{ kind: "at", at: Date.now() + 15 },
			{ kind: "operation", name: "test.tick", version: 1, input: { n: 1 } },
		);
		expect(ticks).toEqual([]);
		await wait(40);
		expect(ticks).toEqual([1]);

		await wait(40);
		expect(ticks).toEqual([1]); // never fires twice
		scheduler.stop();
	});

	it("a one-shot 'at' schedule emits the declared event once", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		registry.registerEvent("owner", Announced);
		const seen: unknown[] = [];
		registry.subscribeLocal("test.announced", 1, (payload) => seen.push(payload));
		const scheduler = new VehicleScheduler(registry);

		scheduler.schedule(
			"owner-1",
			{ kind: "at", at: Date.now() + 15 },
			{ kind: "event", name: "test.announced", version: 1, payload: { n: 7 } },
		);
		await wait(40);
		expect(seen).toEqual([{ n: 7 }]);
		scheduler.stop();
	});

	it("a recurring 'every' schedule keeps firing until canceled", async () => {
		const ticks: number[] = [];
		const registry = registryWithTickOperation((n) => ticks.push(n));
		const scheduler = new VehicleScheduler(registry);

		const handle = scheduler.schedule(
			"owner-1",
			{ kind: "every", intervalMs: 15 },
			{ kind: "operation", name: "test.tick", version: 1, input: { n: 1 } },
		);
		await wait(50);
		expect(ticks.length).toBeGreaterThanOrEqual(2);

		handle.cancel();
		const countAtCancel = ticks.length;
		await wait(40);
		expect(ticks.length).toBe(countAtCancel);
		scheduler.stop();
	});

	it("cancel() is idempotent-shaped -- false for an already-canceled or unknown id", async () => {
		const registry = registryWithTickOperation(() => {});
		const scheduler = new VehicleScheduler(registry);
		const handle = scheduler.schedule(
			"owner-1",
			{ kind: "at", at: Date.now() + 10_000 },
			{
				kind: "operation",
				name: "test.tick",
				version: 1,
				input: { n: 1 },
			},
		);
		expect(handle.cancel()).toBe(true);
		expect(handle.cancel()).toBe(false);
		expect(scheduler.cancel("nope")).toBe(false);
		scheduler.stop();
	});

	it("list() reports current entries, optionally filtered by owner", () => {
		const registry = registryWithTickOperation(() => {});
		const scheduler = new VehicleScheduler(registry);
		scheduler.schedule(
			"owner-a",
			{ kind: "at", at: Date.now() + 10_000 },
			{ kind: "operation", name: "test.tick", version: 1, input: { n: 1 } },
		);
		scheduler.schedule(
			"owner-b",
			{ kind: "at", at: Date.now() + 10_000 },
			{ kind: "operation", name: "test.tick", version: 1, input: { n: 2 } },
		);

		expect(scheduler.list()).toHaveLength(2);
		expect(scheduler.list("owner-a")).toHaveLength(1);
		expect(scheduler.list("owner-a")[0]?.owner).toBe("owner-a");
		scheduler.stop();
	});

	it("bounds schedules per owner, matching WatchRegistry's own fail-closed convention", () => {
		const registry = registryWithTickOperation(() => {});
		const scheduler = new VehicleScheduler(registry, { maxSchedulesPerOwner: 2 });
		const spec = { kind: "operation" as const, name: "test.tick", version: 1, input: { n: 1 } };
		scheduler.schedule("owner-1", { kind: "at", at: Date.now() + 10_000 }, spec);
		scheduler.schedule("owner-1", { kind: "at", at: Date.now() + 10_000 }, spec);
		expect(() => scheduler.schedule("owner-1", { kind: "at", at: Date.now() + 10_000 }, spec)).toThrow(VehicleScheduleLimitExceeded);
		// a different owner is unaffected by owner-1's own bound
		expect(() => scheduler.schedule("owner-2", { kind: "at", at: Date.now() + 10_000 }, spec)).not.toThrow();
		scheduler.stop();
	});

	it("a fire that throws is reported via onFireError and never stops a recurring schedule's future fires", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
		const Fail = defineVehicleOperation({
			name: "test.fail",
			version: 1,
			description: "Always fails.",
			input: inputSchema,
			output: outputSchema,
			effect: "local-write",
			idempotency: { mode: "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			"fail-provider",
			bindVehicleOperation(Fail, () => async () => {
				throw new Error("boom");
			}),
		);
		const errors: unknown[] = [];
		const scheduler = new VehicleScheduler(registry, { onFireError: (_entry, error) => errors.push(error) });
		scheduler.schedule("owner-1", { kind: "every", intervalMs: 15 }, { kind: "operation", name: "test.fail", version: 1, input: { n: 1 } });

		await wait(50);
		expect(errors.length).toBeGreaterThanOrEqual(2); // kept firing despite each failure
		scheduler.stop();
	});

	it("restore() re-arms a persisted overdue one-shot almost immediately, never silently dropping it", async () => {
		const ticks: number[] = [];
		const registry = registryWithTickOperation((n) => ticks.push(n));
		const fakePersistence = {
			async load() {
				return {
					version: 1 as const,
					savedAt: Date.now(),
					entries: [
						{
							scheduleId: "sched-restored",
							owner: "owner-1",
							trigger: { kind: "at" as const, at: Date.now() - 60_000 }, // long overdue
							action: { kind: "operation" as const, name: "test.tick", version: 1, input: { n: 42 } },
							createdAt: Date.now() - 61_000,
							nextFireAt: Date.now() - 60_000,
						},
					],
				};
			},
			async save() {},
		};
		const scheduler = new VehicleScheduler(registry, { persistence: fakePersistence });

		const result = await scheduler.restore();
		expect(result.restoredCount).toBe(1);
		await wait(20);
		expect(ticks).toEqual([42]);
		scheduler.stop();
	});

	it("restore() persists the newly re-armed state so a corrected recurring cadence survives a second restart", async () => {
		const registry = registryWithTickOperation(() => {});
		const saved: unknown[] = [];
		const fakePersistence = {
			async load() {
				return {
					version: 1 as const,
					savedAt: 1_000,
					entries: [
						{
							scheduleId: "sched-recurring",
							owner: "owner-1",
							trigger: { kind: "every" as const, intervalMs: 60_000 },
							action: { kind: "operation" as const, name: "test.tick", version: 1, input: { n: 1 } },
							createdAt: 0,
							nextFireAt: 500, // long overdue -- should resume cadence from now, not fire immediately
						},
					],
				};
			},
			async save(snapshot: unknown) {
				saved.push(snapshot);
			},
		};
		const scheduler = new VehicleScheduler(registry, { persistence: fakePersistence, now: () => 100_000 });
		await scheduler.restore();
		await wait(10);

		const latest = saved.at(-1) as { entries: Array<{ nextFireAt: number }> };
		expect(latest.entries[0]?.nextFireAt).toBe(160_000); // 100_000 + 60_000, resumed cadence, not the stale 500
		scheduler.stop();
	});
});
