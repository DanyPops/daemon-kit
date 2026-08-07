import { afterEach, describe, expect, it } from "bun:test";
import {
	publishVehicleActivity,
	registerActivityBroker,
	unregisterActivityBroker,
	type VehicleActivityEvent,
} from "../src/activity-broker.ts";

function event(overrides: Partial<VehicleActivityEvent> = {}): VehicleActivityEvent {
	return {
		type: "vehicle.operation.started",
		source: "vehicle",
		severity: "info",
		importance: "noisy",
		summary: "test.op started",
		...overrides,
	};
}

describe("activity broker", () => {
	afterEach(() => {
		unregisterActivityBroker();
	});

	it("is a true no-op when no broker has ever been registered", () => {
		expect(() => publishVehicleActivity(event())).not.toThrow();
	});

	it("delivers the event unchanged to a registered broker", () => {
		const received: VehicleActivityEvent[] = [];
		registerActivityBroker({ publish: (evt) => received.push(evt) });

		const evt = event({ summary: "issues.sync completed", severity: "success" });
		publishVehicleActivity(evt);

		expect(received).toEqual([evt]);
	});

	it("never throws even when the broker's own publish() throws", () => {
		registerActivityBroker({
			publish: () => {
				throw new Error("subscriber bug");
			},
		});

		expect(() => publishVehicleActivity(event())).not.toThrow();
	});

	// Structural duck typing only.
	it("treats a globalThis value lacking a publish() method as absent", () => {
		registerActivityBroker({ publish: 42 } as never);
		expect(() => publishVehicleActivity(event())).not.toThrow();
	});

	it("unregisterActivityBroker() restores the no-op state", () => {
		const received: VehicleActivityEvent[] = [];
		registerActivityBroker({ publish: (evt) => received.push(evt) });
		unregisterActivityBroker();

		publishVehicleActivity(event());
		expect(received).toEqual([]);
	});
});
