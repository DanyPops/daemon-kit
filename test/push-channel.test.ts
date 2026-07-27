import { afterEach, describe, expect, it } from "bun:test";
import { PushChannel } from "../src/push-channel.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
const sockets: WebSocket[] = [];

afterEach(() => {
	for (const ws of sockets) ws.close();
	sockets.length = 0;
	server?.stop(true);
	server = undefined;
});

function startPushServer(options?: { maxConnections?: number; maxTopicsPerConnection?: number }): { url: string; channel: PushChannel } {
	const channel = new PushChannel({ token: "push-token", ...options });
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request, bunServer) => {
			if (new URL(request.url).pathname === "/push") return channel.upgrade(request, bunServer) ?? undefined;
			return new Response("not found", { status: 404 });
		},
		websocket: channel.websocketHandlers(),
	});
	return { url: `ws://127.0.0.1:${server.port}/push`, channel };
}

function connect(url: string, token: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${url}?token=${token}`);
		sockets.push(ws);
		ws.addEventListener("open", () => resolve(ws), { once: true });
		ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
	});
}

function nextMessage(ws: WebSocket): Promise<unknown> {
	return new Promise((resolve) => {
		ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true });
	});
}

describe("PushChannel", () => {
	it("rejects an upgrade with the wrong token, never establishing a subscriber", async () => {
		const { url, channel } = startPushServer();
		const response = await fetch(`${url.replace("ws://", "http://")}?token=wrong`);
		expect(response.status).toBe(401);
		expect(channel.connectionCount).toBe(0);
	});

	it("a subscribed client receives a publish() on its topic, and not on others", async () => {
		const { url, channel } = startPushServer();
		const ws = await connect(url, "push-token");
		ws.send(JSON.stringify({ op: "subscribe", topic: "tasks" }));
		await new Promise((resolve) => setTimeout(resolve, 10)); // let the subscribe message land server-side

		const received = nextMessage(ws);
		channel.publish("other-topic", { ignored: true });
		channel.publish("tasks", { mutated: "task-1" });
		expect(await received).toEqual({ topic: "tasks", payload: { mutated: "task-1" } });
	});

	it("publish() to a topic with no subscribers is a safe no-op", () => {
		const { channel } = startPushServer();
		expect(() => channel.publish("nobody-listening", { x: 1 })).not.toThrow();
	});

	it("unsubscribe stops further delivery on that topic", async () => {
		const { url, channel } = startPushServer();
		const ws = await connect(url, "push-token");
		ws.send(JSON.stringify({ op: "subscribe", topic: "tasks" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		ws.send(JSON.stringify({ op: "unsubscribe", topic: "tasks" }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		let received = false;
		ws.addEventListener("message", () => {
			received = true;
		});
		channel.publish("tasks", { mutated: "task-2" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(received).toBe(false);
	});

	it("closing a connection removes it from every topic it was subscribed to", async () => {
		const { url, channel } = startPushServer();
		const ws = await connect(url, "push-token");
		ws.send(JSON.stringify({ op: "subscribe", topic: "tasks" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(channel.connectionCount).toBe(1);
		ws.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(channel.connectionCount).toBe(0);
		expect(() => channel.publish("tasks", { x: 1 })).not.toThrow();
	});

	it("rejects an upgrade once maxConnections is reached", async () => {
		const { url } = startPushServer({ maxConnections: 1 });
		await connect(url, "push-token");
		const response = await fetch(`${url.replace("ws://", "http://")}?token=push-token`);
		expect(response.status).toBe(503);
	});

	it("silently ignores a subscribe beyond maxTopicsPerConnection rather than growing unbounded", async () => {
		const { url, channel } = startPushServer({ maxTopicsPerConnection: 1 });
		const ws = await connect(url, "push-token");
		ws.send(JSON.stringify({ op: "subscribe", topic: "a" }));
		ws.send(JSON.stringify({ op: "subscribe", topic: "b" })); // beyond the bound -- must be ignored
		await new Promise((resolve) => setTimeout(resolve, 10));

		// No direct introspection of a connection's own topic set is exposed --
		// the real proof is behavioral: only the allowed topic actually delivers.
		const received: unknown[] = [];
		ws.addEventListener("message", (event) => received.push(JSON.parse(event.data as string)));
		channel.publish("a", { from: "a" });
		channel.publish("b", { from: "b" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(received).toEqual([{ topic: "a", payload: { from: "a" } }]);
	});

	it("responds to a ping control message with a pong", async () => {
		const { url } = startPushServer();
		const ws = await connect(url, "push-token");
		const pong = nextMessage(ws);
		ws.send(JSON.stringify({ op: "ping" }));
		expect(await pong).toEqual({ op: "pong" });
	});
});
