import { describe, expect, it } from "bun:test";
import { WatchLimitExceeded, WatchRegistry } from "../src/vehicle-watchers.ts";

describe("WatchRegistry: duplicate watch-id identity corruption", () => {
	it("rejects a cross-scope duplicate watchId without mutating either scope", () => {
		const registry = new WatchRegistry();
		registry.add("scope-a", "r1", "w1", "t1");

		expect(() => registry.add("scope-b", "r2", "w1", "t2")).toThrow();

		expect(registry.registrationsFor("scope-a")).toEqual([{ watchId: "w1", scope: "scope-a", resource: "r1", topic: "t1" }]);
		expect(registry.registrationsFor("scope-b")).toEqual([]);
		expect(registry.hasAnyFor("scope-b")).toBe(false);
	});

	it("leaves the original registration queryable and removable after a rejected cross-scope duplicate", () => {
		const registry = new WatchRegistry();
		registry.add("scope-a", "r1", "w1", "t1");
		expect(() => registry.add("scope-b", "r2", "w1", "t2")).toThrow();

		expect(registry.remove("w1")).toMatchObject({ watchId: "w1", scope: "scope-a" });
		expect(registry.hasAnyFor("scope-a")).toBe(false);
	});

	it("rejects a same-scope duplicate watchId too, not just a cross-scope one", () => {
		const registry = new WatchRegistry();
		registry.add("scope-a", "r1", "w1", "t1");

		expect(() => registry.add("scope-a", "r2", "w1", "t2")).toThrow();
		expect(registry.registrationsFor("scope-a")).toEqual([{ watchId: "w1", scope: "scope-a", resource: "r1", topic: "t1" }]);
	});

	it("a rejected duplicate never consumes a slot against the scope's own bound", () => {
		const registry = new WatchRegistry({ maxWatchesPerScope: 2 });
		registry.add("scope-a", "r1", "w1", "t1");

		expect(() => registry.add("scope-a", "r2", "w1", "t2")).toThrow();
		// scope-a still has only its one real watch (w1) -- a distinct new id fits under
		// the bound of 2, proving the rejected duplicate never counted against it.
		expect(() => registry.add("scope-a", "r3", "w2", "t3")).not.toThrow();
	});

	it("still enforces WatchLimitExceeded for a genuinely new watchId once a scope is full", () => {
		const registry = new WatchRegistry({ maxWatchesPerScope: 1 });
		registry.add("scope-a", "r1", "w1", "t1");
		expect(() => registry.add("scope-a", "r2", "w2", "t2")).toThrow(WatchLimitExceeded);
	});
});
