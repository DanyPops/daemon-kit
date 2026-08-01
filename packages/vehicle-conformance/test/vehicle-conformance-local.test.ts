import { LocalVehicleClient } from "@danypops/vehicle-client/local";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { registerConformanceOperations, runVehicleClientConformance } from "../src/vehicle-conformance.ts";

runVehicleClientConformance({
	label: "LocalVehicleClient",
	async create() {
		const registry = new VehicleRegistry({ name: "conformance-local", version: "1.0.0", description: "Local conformance fixture" });
		registerConformanceOperations(registry);
		const client = new LocalVehicleClient(registry);
		return { client, cleanup: () => client.close() };
	},
});
