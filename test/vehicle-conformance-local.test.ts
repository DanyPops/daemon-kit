import { LocalVehicleClient, VehicleRegistry } from "../src/vehicle.ts";
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
