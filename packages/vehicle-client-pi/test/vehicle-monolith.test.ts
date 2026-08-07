import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { verifyLoadableUnderPi } from "../src/pi-load-harness.ts";
import { createMonolithVehicle } from "../src/vehicle-monolith.ts";

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

const echoSchema = defineVehicleSchema<{ text: string }>({
	jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	safeParse: (value) => {
		if (typeof value !== "object" || value === null || typeof (value as { text?: unknown }).text !== "string") {
			return { success: false, issues: [{ path: ["text"], message: "text is required" }] };
		}
		return { success: true, value: value as { text: string } };
	},
});

function registerEcho(registry: import("@danypops/vehicle-server").VehicleRegistry): void {
	const operation = defineVehicleOperation({
		name: "echo.say",
		version: 1,
		description: "Echoes the given text back.",
		input: echoSchema,
		output: echoSchema,
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		limits,
	});
	registry.register(
		"echo",
		bindVehicleOperation(operation, () => async (context) => ({ text: `echo: ${context.input.text}` })),
	);
}

async function createViaHarness(info: Parameters<typeof createMonolithVehicle>[1], register: Parameters<typeof createMonolithVehicle>[2]) {
	const harness = createExtensionHarness(() => {});
	const monolith = await createMonolithVehicle(harness.api, info, register);
	return { monolith, tools: [...harness.tools.values()].map((t) => t.definition) };
}

describe("createMonolithVehicle", () => {
	// No network involved.
	it("bundles a fresh VehicleRegistry + LocalVehicleClient + registerVehicleTools into one call", async () => {
		const { monolith, tools } = await createViaHarness({ name: "echo-vehicle", version: "1.0.0", description: "test" }, registerEcho);

		expect(monolith.registry.manifest().operations.map((op) => op.name)).toEqual(["echo.say"]);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("echo_say");

		const result = await tools[0]!.execute("call-1", { text: "hello" }, undefined, undefined, {
			sessionManager: { getSessionId: () => "session-1" },
			hasUI: false,
		} as never);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("echo: hello") });
	});

	it("the returned client is the exact LocalVehicleClient calling the same registry directly", async () => {
		const { monolith } = await createViaHarness({ name: "echo-vehicle", version: "1.0.0", description: "test" }, registerEcho);
		const output = await monolith.client.invoke<{ text: string }>("echo.say", 1, { text: "direct" });
		expect(output.text).toBe("echo: direct");
	});

	// Registering nothing yields zero tools, not an error.
	it("register receives the real registry before any tool projection happens", async () => {
		const { tools } = await createViaHarness({ name: "empty-vehicle", version: "1.0.0", description: "test" }, () => {});
		expect(tools).toHaveLength(0);
	});

	// native ESM, jiti with/without tryNative -- both source and the compiled artifact.
	it("loads under every Pi extension load path", async () => {
		const SRC = resolve(import.meta.dir, "..", "src", "vehicle-monolith.ts");
		const DIST = resolve(import.meta.dir, "..", "dist", "vehicle-monolith.js");
		for (const path of [SRC, DIST]) {
			const results = await verifyLoadableUnderPi(path);
			for (const result of results) {
				expect(result.ok, `${result.path} failed loading ${path}: ${result.error ?? "(no error)"}`).toBe(true);
			}
		}
	});
});
