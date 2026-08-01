import { describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { LocalVehicleClient } from "../src/vehicle-local-client.ts";

const echoSchema = defineVehicleSchema<{ value: string }>({
	jsonSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
	safeParse(value: unknown) {
		if (typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "string") {
			return { success: true, value: value as { value: string } };
		}
		return { success: false, issues: [{ path: ["value"], message: "value must be a string" }] };
	},
});

const Echo = defineVehicleOperation({
	name: "test.echo",
	version: 1,
	description: "Echo a string.",
	input: echoSchema,
	output: echoSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 },
});

function clientWith(): LocalVehicleClient {
	const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
	registry.register(
		"echo-provider",
		bindVehicleOperation(
			Echo,
			() =>
				async ({ input }) =>
					input,
		),
	);
	return new LocalVehicleClient(registry);
}

describe("LocalVehicleClient", () => {
	it("passes manifest()/invoke() straight through to the wrapped registry", async () => {
		const client = clientWith();
		const manifest = await client.manifest();
		expect(manifest.operations.map((op) => op.name)).toEqual(["test.echo"]);
		await expect(client.invoke("test.echo", 1, { value: "hi" })).resolves.toEqual({ value: "hi" });
	});

	it("refuses invocation and manifest() after close(), as a rejected promise not a thrown exception", async () => {
		const client = clientWith();
		await client.close();
		await expect(client.manifest()).rejects.toMatchObject({ code: "client-closed", category: "unavailable" });
		await expect(client.invoke("test.echo", 1, { value: "hi" })).rejects.toMatchObject({ code: "client-closed" });
	});
});
