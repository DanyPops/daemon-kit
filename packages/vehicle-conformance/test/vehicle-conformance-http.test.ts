import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { registerConformanceOperations, runVehicleClientConformance } from "../src/vehicle-conformance.ts";

runVehicleClientConformance({
	label: "RemoteVehicleClient (HTTP)",
	async create() {
		const registry = new VehicleRegistry({ name: "conformance-http", version: "1.0.0", description: "HTTP conformance fixture" });
		registerConformanceOperations(registry);
		const token = "conformance-token";
		const app = createVehicleHttpApp({ registry, token });
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
		const client = new RemoteVehicleClient({ baseUrl: `http://127.0.0.1:${server.port}`, token });
		return {
			client,
			cleanup: async () => {
				await client.close();
				server.stop(true);
			},
		};
	},
});
