import { afterEach, describe, expect, it } from "bun:test";
import {
	bindVehicleOperation,
	defineVehicleEvent,
	defineVehicleOperation,
	defineVehicleSchema,
	type JsonValue,
	VehicleError,
} from "@danypops/vehicle-core";
import { bridgeVehicleEventsToPushChannel, VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { LocalVehicleClient } from "../src/vehicle-local-client.ts";
import { RemoteVehicleClient } from "../src/vehicle-http-client.ts";

const objectSchema = <T extends Record<string, unknown>>(properties: Record<string, JsonValue>, parse: (value: unknown) => T | undefined) =>
	defineVehicleSchema<T>({
		jsonSchema: { type: "object", properties, additionalProperties: false },
		safeParse(value) {
			const parsed = parse(value);
			return parsed ? { success: true, value: parsed } : { success: false, issues: [{ path: [], message: "invalid object" }] };
		},
	});

type AnnouncementInput = { message: string };
type AnnouncementPayload = { message: string };

const announcementSchema = objectSchema<AnnouncementPayload>({ message: { type: "string" } }, (value) =>
	typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string"
		? { message: (value as { message: string }).message }
		: undefined,
);

const LIMITS = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 4_096, maxResponseBytes: 4_096 } as const;

const Announced = defineVehicleEvent({
	name: "test.announced",
	version: 1,
	description: "Fired whenever test.announce runs.",
	payload: announcementSchema,
	maxPayloadBytes: 4_096,
});

const Announce = defineVehicleOperation({
	name: "test.announce",
	version: 1,
	description: "Emits test.announced with the given message.",
	input: announcementSchema,
	output: objectSchema<{ ok: boolean }>({ ok: { type: "boolean" } }, (value) =>
		typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean" ? { ok: (value as { ok: boolean }).ok } : undefined,
	),
	permissions: [],
	effect: "local-write",
	idempotency: { mode: "unsafe" },
	limits: LIMITS,
});

function buildRegistry(): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "test-vehicle", version: "1.0.0", description: "Test Vehicle" });
	registry.registerEvent("test-owner", Announced);
	registry.register(
		"test-owner",
		bindVehicleOperation(Announce, () => async (context: { input: AnnouncementInput }) => {
			registry.emit("test.announced", 1, { message: context.input.message });
			return { ok: true };
		}),
	);
	return registry;
}

describe("Vehicle Events: registerEvent/emit/subscribe walking skeleton", () => {
	it("VehicleRegistry.manifest() lists the declared event type", () => {
		const registry = buildRegistry();
		expect(registry.manifest().events).toEqual([Announced.descriptor]);
	});

	it("emit() rejects a payload that fails the declared schema", () => {
		const registry = buildRegistry();
		expect(() => registry.emit("test.announced", 1, { message: 42 })).toThrow(VehicleError);
	});

	it("emit() rejects an oversized payload the same way enforcePayloadSize rejects an oversized operation response", () => {
		const registry = new VehicleRegistry({ name: "test-vehicle", version: "1.0.0", description: "Test Vehicle" });
		registry.registerEvent(
			"test-owner",
			defineVehicleEvent({ name: "test.tiny", version: 1, description: "A tiny-budget event.", payload: announcementSchema, maxPayloadBytes: 8 }),
		);
		expect(() => registry.emit("test.tiny", 1, { message: "this message is definitely too long for 8 bytes" })).toThrow(
			/exceeds its 8-byte limit/,
		);
	});

	it("emit() throws not-found for an event nobody declared", () => {
		const registry = buildRegistry();
		expect(() => registry.emit("test.never-declared", 1, {})).toThrow(/No Vehicle event is registered/);
	});

	it("a bad local listener never breaks emit() for other listeners or the emitting handler", async () => {
		const registry = buildRegistry();
		const received: AnnouncementPayload[] = [];
		registry.subscribeLocal("test.announced", 1, () => {
			throw new Error("a badly-behaved subscriber");
		});
		registry.subscribeLocal("test.announced", 1, (payload) => received.push(payload as AnnouncementPayload));
		const client = new LocalVehicleClient(registry);
		const output = await client.invoke("test.announce", 1, { message: "hi" });
		expect(output).toEqual({ ok: true });
		expect(received).toEqual([{ message: "hi" }]);
	});

	it("LocalVehicleClient.subscribe() receives a real event emitted by a real invoked operation", async () => {
		const registry = buildRegistry();
		const client = new LocalVehicleClient(registry);
		const received: AnnouncementPayload[] = [];
		const subscription = client.subscribe<AnnouncementPayload>("test.announced", 1, (payload) => received.push(payload));

		await client.invoke("test.announce", 1, { message: "first" });
		expect(received).toEqual([{ message: "first" }]);

		subscription.close();
		await client.invoke("test.announce", 1, { message: "second (after unsubscribe)" });
		expect(received).toEqual([{ message: "first" }]);
	});

	describe("RemoteVehicleClient.subscribe(), over a real HTTP + push-channel server", () => {
		let server: ReturnType<typeof Bun.serve> | undefined;

		afterEach(() => {
			server?.stop(true);
			server = undefined;
		});

		function startServer(): { httpUrl: string; pushUrl: string; token: string; registry: VehicleRegistry } {
			const token = "test-token";
			const registry = buildRegistry();
			const pushChannel = new PushChannel({ token });
			bridgeVehicleEventsToPushChannel(registry, pushChannel);
			const app = createVehicleHttpApp({ registry, token });
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: (request, bunServer) => {
					if (new URL(request.url).pathname === "/push") return pushChannel.upgrade(request, bunServer) ?? undefined;
					return app.fetch(request);
				},
				websocket: pushChannel.websocketHandlers(),
			});
			const port = server.port;
			return { httpUrl: `http://127.0.0.1:${port}`, pushUrl: `ws://127.0.0.1:${port}/push`, token, registry };
		}

		it("delivers a real event, emitted by a real invoked operation, over the real push channel", async () => {
			const { httpUrl, pushUrl, token } = startServer();
			const client = new RemoteVehicleClient({ baseUrl: httpUrl, token, pushUrl });

			const received: AnnouncementPayload[] = [];
			const subscription = client.subscribe<AnnouncementPayload>("test.announced", 1, (payload) => received.push(payload));
			await new Promise((resolve) => setTimeout(resolve, 20)); // let the WS connect + subscribe frame land server-side

			const output = await client.invoke("test.announce", 1, { message: "hello over the wire" });
			expect(output).toEqual({ ok: true });

			await new Promise((resolve) => setTimeout(resolve, 20)); // let the push frame arrive
			expect(received).toEqual([{ message: "hello over the wire" }]);

			subscription.close();
		});

		it("manifest() over HTTP reports the declared event the same way the local registry does", async () => {
			const { httpUrl, token, registry } = startServer();
			const client = new RemoteVehicleClient({ baseUrl: httpUrl, token });
			const manifest = await client.manifest();
			expect(manifest.events).toEqual(registry.manifest().events);
		});
	});
});
