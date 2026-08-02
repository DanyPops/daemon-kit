import { afterEach, describe, expect, it } from "bun:test";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { chatMessageReceivedEvent, createChatBridgeApp, registerChatOperations } from "../src/daemon.ts";

const TOKEN = "test-token";
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

function startDaemon() {
	const registry = new VehicleRegistry({ name: "chat-bridge-template", version: "1.0.0", description: "test" });
	const state = registerChatOperations(registry);
	const app = createChatBridgeApp(registry, state, TOKEN);
	server = Bun.serve({ port: 0, fetch: app.fetch });
	return { registry, state, baseUrl: `http://127.0.0.1:${server.port}` };
}

describe("chat-bridge template", () => {
	it("registers chat.send/chat.history and the chat.message.received event", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.0.0", description: "test" });
		const state = registerChatOperations(registry);
		const manifest = registry.manifest();
		expect(manifest.operations.map((op) => op.name).sort()).toEqual(["chat.history", "chat.send"]);
		expect(manifest.events?.map((event) => event.name)).toEqual(["chat.message.received"]);
		expect(state).toEqual({ sent: [], received: [] });
	});

	it("chat.send is reachable as a real Vehicle operation over HTTP, via RemoteVehicleClient -- the Pi tool surface", async () => {
		const { baseUrl } = startDaemon();
		const client = new RemoteVehicleClient({ baseUrl, token: TOKEN });
		const result = await client.invoke("chat.send", 1, { to: "#general", text: "hello from the bridge" });
		expect(result).toEqual({ sent: true, to: "#general" });
		await client.close();
	});

	it("the /webhook route is the second transport, sharing the same process and port as the Vehicle wire protocol", async () => {
		const { baseUrl, state } = startDaemon();

		const response = await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: "alice", text: "hi there" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ received: true });
		expect(state.received).toHaveLength(1);
		expect(state.received[0]).toMatchObject({ from: "alice", text: "hi there" });
	});

	it("the webhook rejects a malformed body instead of crashing the process", async () => {
		const { baseUrl } = startDaemon();
		const response = await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: "alice" }),
		});
		expect(response.status).toBe(400);
	});

	it("chat.history reflects both a sent and a received message, via the real Vehicle wire protocol", async () => {
		const { baseUrl } = startDaemon();
		const client = new RemoteVehicleClient({ baseUrl, token: TOKEN });
		await client.invoke("chat.send", 1, { to: "#general", text: "outbound" });
		await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: "bob", text: "inbound" }),
		});

		const history = (await client.invoke("chat.history", 1, {})) as { sent: unknown[]; received: unknown[] };
		expect(history.sent).toHaveLength(1);
		expect(history.received).toHaveLength(1);
		await client.close();
	});

	it("emitting chat.message.received is observable through the registry's own subscribeLocal, for an in-process listener", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.0.0", description: "test" });
		const state = registerChatOperations(registry);
		const app = createChatBridgeApp(registry, state, TOKEN);
		server = Bun.serve({ port: 0, fetch: app.fetch });

		const seen: unknown[] = [];
		registry.subscribeLocal(chatMessageReceivedEvent.descriptor.name, chatMessageReceivedEvent.descriptor.version, (payload) =>
			seen.push(payload),
		);

		await fetch(`http://127.0.0.1:${server.port}/webhook`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: "carol", text: "ping" }),
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ from: "carol", text: "ping" });
	});
});
