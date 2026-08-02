/**
 * A real, runnable Pi extension demonstrating Monolith Mode end to end:
 * no daemon, no HTTP, no port, no systemd unit -- the provider (this file)
 * and its one consumer (the Pi session that loads it) share a process.
 *
 * Try it:
 *   pi --extension ./monolith-echo-extension.ts --print "call the echo_say tool with text 'hello from monolith mode'"
 *
 * `createMonolithVehicle` bundles a fresh VehicleRegistry, a
 * LocalVehicleClient wrapping it directly (zero network), and
 * registerVehicleTools() projecting its operations onto real Pi tools --
 * the same per-operation schemas, effect classification, and generic
 * rendering a daemon-backed Vehicle gets, with none of the deployment
 * overhead. See the root README's "Split vs Monolith" section for when to
 * pick this over the daemon+HTTP Split.
 */
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMonolithVehicle } from "../src/vehicle-monolith.js";

interface EchoInput {
	text: string;
}

const echoSchema = defineVehicleSchema<EchoInput>({
	jsonSchema: {
		type: "object",
		properties: { text: { type: "string", description: "The text to echo back." } },
		required: ["text"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (typeof value !== "object" || value === null || typeof (value as { text?: unknown }).text !== "string") {
			return { success: false, issues: [{ path: ["text"], message: "text is required and must be a string" }] };
		}
		return { success: true, value: value as EchoInput };
	},
});

export default async function (pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", async () => {
		await createMonolithVehicle(pi, { name: "echo-monolith", version: "1.0.0", description: "A single-file, no-daemon Vehicle." }, (registry) => {
			const echo = defineVehicleOperation({
				name: "echo.say",
				version: 1,
				description: "Echoes the given text back, uppercased -- proves a real operation ran, not a stub.",
				input: echoSchema,
				output: echoSchema,
				permissions: [],
				effect: "read",
				idempotency: { mode: "safe" },
				limits: { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 4_096, maxResponseBytes: 4_096 },
			});
			registry.register(
				"echo",
				bindVehicleOperation(echo, () => async (context) => ({ text: context.input.text.toUpperCase() })),
			);
		});
	});
}
