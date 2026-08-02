import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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

function fakePi() {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		getAllTools() {
			return [];
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
		on() {},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

describe("createMonolithVehicle", () => {
	it("bundles a fresh VehicleRegistry + LocalVehicleClient + registerVehicleTools into one call, no network involved", async () => {
		const { pi, tools } = fakePi();
		const monolith = await createMonolithVehicle(pi, { name: "echo-vehicle", version: "1.0.0", description: "test" }, registerEcho);

		expect(monolith.registry.manifest().operations.map((op) => op.name)).toEqual(["echo.say"]);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("echo_say");

		const result = await tools[0]!.execute(
			"call-1",
			{ text: "hello" },
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "session-1" }, hasUI: false } as never,
		);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("echo: hello") });
	});

	it("the returned client is the exact LocalVehicleClient instance calling the same registry directly", async () => {
		const { pi } = fakePi();
		const monolith = await createMonolithVehicle(pi, { name: "echo-vehicle", version: "1.0.0", description: "test" }, registerEcho);
		const output = await monolith.client.invoke<{ text: string }>("echo.say", 1, { text: "direct" });
		expect(output.text).toBe("echo: direct");
	});

	it("register receives the real registry before any tool projection happens -- registering nothing yields zero tools, not an error", async () => {
		const { pi, tools } = fakePi();
		await createMonolithVehicle(pi, { name: "empty-vehicle", version: "1.0.0", description: "test" }, () => {});
		expect(tools).toHaveLength(0);
	});

	it("loads under every Pi extension load path (native ESM, jiti with/without tryNative) -- both source and the compiled artifact", async () => {
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
