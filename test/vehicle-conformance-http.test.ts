import { RemoteVehicleClient, VehicleRegistry } from "../src/vehicle.ts";
import { registerConformanceOperations, runVehicleClientConformance } from "../src/vehicle-conformance.ts";
import { createVehicleHttpApp } from "../src/vehicle-http-provider.ts";

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
