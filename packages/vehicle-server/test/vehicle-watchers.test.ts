import { describe, expect, it } from "bun:test";
import { VehicleError, vehicleWatchTopic, WatchLimitExceeded, WatchRegistry } from "@danypops/vehicle-core";
import { createVehicleWatchOperations } from "../src/vehicle-watchers.ts";
import { VehicleRegistry } from "../src/vehicle-registry.ts";

const LIMITS = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 } as const;

function buildRegistry(watchRegistry: WatchRegistry, scopeOf?: () => string) {
	const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
	const { watch, unwatch } = createVehicleWatchOperations({
		name: "resource",
		registry: watchRegistry,
		limits: LIMITS,
		...(scopeOf ? { scopeOf } : {}),
	});
	registry.register("test-owner", watch);
	registry.register("test-owner", unwatch);
	return registry;
}

describe("WatchRegistry (vehicle-core)", () => {
	it("bounds a scope's watches to its configured maximum", () => {
		const registry = new WatchRegistry({ maxWatchesPerScope: 2 });
		registry.add("scope-a", "r1", "w1", "t1");
		registry.add("scope-a", "r2", "w2", "t2");
		expect(() => registry.add("scope-a", "r3", "w3", "t3")).toThrow(WatchLimitExceeded);
		// A different scope is unaffected by scope-a's own bound.
		expect(() => registry.add("scope-b", "r1", "w4", "t4")).not.toThrow();
	});

	it("remove() is idempotent and returns the removed registration once", () => {
		const registry = new WatchRegistry();
		registry.add("scope-a", "r1", "w1", "t1");
		expect(registry.remove("w1")).toMatchObject({ watchId: "w1" });
		expect(registry.remove("w1")).toBeUndefined();
	});

	it("hasAnyFor() reflects a scope emptying out after its last watch is removed", () => {
		const registry = new WatchRegistry();
		registry.add("scope-a", "r1", "w1", "t1");
		expect(registry.hasAnyFor("scope-a")).toBe(true);
		registry.remove("w1");
		expect(registry.hasAnyFor("scope-a")).toBe(false);
	});
});

describe("createVehicleWatchOperations", () => {
	it("watch() registers with WatchRegistry under the default scope and returns a stable topic", async () => {
		const watchRegistry = new WatchRegistry();
		const registry = buildRegistry(watchRegistry);
		const output = await registry.invoke("resource.watch", 1, { resource: "task-42" });
		expect(output).toMatchObject({ topic: vehicleWatchTopic((output as { watchId: string }).watchId) });
		expect(watchRegistry.registrationsFor("default")).toHaveLength(1);
		expect(watchRegistry.registrationsFor("default")[0]).toMatchObject({ resource: "task-42" });
	});

	it("unwatch() removes the registration and reports unwatched:true, then false on a second call", async () => {
		const watchRegistry = new WatchRegistry();
		const registry = buildRegistry(watchRegistry);
		const { watchId } = (await registry.invoke("resource.watch", 1, { resource: "task-42" })) as { watchId: string };
		expect(await registry.invoke("resource.unwatch", 1, { watchId })).toEqual({ unwatched: true });
		expect(await registry.invoke("resource.unwatch", 1, { watchId })).toEqual({ unwatched: false });
		expect(watchRegistry.hasAnyFor("default")).toBe(false);
	});

	it("rejects a watch input missing resource, before ever touching the WatchRegistry", async () => {
		const watchRegistry = new WatchRegistry();
		const registry = buildRegistry(watchRegistry);
		await expect(registry.invoke("resource.watch", 1, {})).rejects.toBeInstanceOf(VehicleError);
		expect(watchRegistry.registrationsFor("default")).toHaveLength(0);
	});

	it("a custom scopeOf() buckets watches per caller instead of the single default scope", async () => {
		const watchRegistry = new WatchRegistry();
		let currentPrincipal = "alice";
		const registry = buildRegistry(watchRegistry, () => currentPrincipal);

		await registry.invoke("resource.watch", 1, { resource: "task-1" });
		currentPrincipal = "bob";
		await registry.invoke("resource.watch", 1, { resource: "task-2" });

		expect(watchRegistry.registrationsFor("alice")).toHaveLength(1);
		expect(watchRegistry.registrationsFor("bob")).toHaveLength(1);
	});

	it("surfaces WatchLimitExceeded as a real invoke() failure once a scope is at its bound", async () => {
		const watchRegistry = new WatchRegistry({ maxWatchesPerScope: 1 });
		const registry = buildRegistry(watchRegistry);
		await registry.invoke("resource.watch", 1, { resource: "task-1" });
		try {
			await registry.invoke("resource.watch", 1, { resource: "task-2" });
			throw new Error("expected invocation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(VehicleError);
			expect((error as VehicleError).cause).toBeInstanceOf(WatchLimitExceeded);
			expect(((error as VehicleError).cause as WatchLimitExceeded).message).toContain("already has 1 active watches");
		}
	});
});
