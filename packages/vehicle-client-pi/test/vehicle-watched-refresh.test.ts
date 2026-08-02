import { afterEach, describe, expect, it } from "bun:test";
import { vehicleWatchTopic, WatchRegistry } from "@danypops/vehicle-core";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { createVehicleWatchOperations } from "@danypops/vehicle-server/watchers";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { startWatchedRefresh, type VehicleWatchTarget } from "../src/vehicle-watched-refresh.ts";

const LIMITS = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 } as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startWatchedRefresh: Pi-side generic watch/unwatch + push/poll refresh helper", () => {
	it("calls refresh immediately and on each poll tick, without ever attempting a push connection when resolvePushTarget returns undefined", async () => {
		let refreshCount = 0;
		let watchCalls = 0;
		const handle = startWatchedRefresh({
			watch: async () => {
				watchCalls++;
				return undefined; // daemon unreachable -- the realistic "poll only" case
			},
			resolvePushTarget: () => undefined,
			refresh: () => {
				refreshCount++;
			},
			pollIntervalMs: 15,
		});

		await sleep(50);
		handle.stop();

		expect(refreshCount).toBeGreaterThanOrEqual(2); // the immediate call plus at least one tick
		expect(watchCalls).toBeGreaterThanOrEqual(1); // retried watch() despite it returning undefined every time
	});

	it("stop() is idempotent and stops further refresh/watch activity", async () => {
		let refreshCount = 0;
		const handle = startWatchedRefresh({
			watch: async () => undefined,
			resolvePushTarget: () => undefined,
			refresh: () => {
				refreshCount++;
			},
			pollIntervalMs: 10,
		});
		await sleep(15);
		handle.stop();
		const countAtStop = refreshCount;
		handle.stop(); // idempotent -- must not throw or double-clear
		await sleep(30);
		expect(refreshCount).toBe(countAtStop);
	});

	describe("against a real HTTP + push-channel Vehicle server", () => {
		let server: ReturnType<typeof Bun.serve> | undefined;

		afterEach(() => {
			server?.stop(true);
			server = undefined;
		});

		function startServer(): { baseUrl: string; pushUrl: string; token: string; pushChannel: PushChannel } {
			const token = "test-token";
			const watchRegistry = new WatchRegistry();
			const registry = new VehicleRegistry({ name: "test", version: "1", description: "Test." });
			const { watch, unwatch } = createVehicleWatchOperations({ name: "resource", registry: watchRegistry, limits: LIMITS });
			registry.register("test-owner", watch);
			registry.register("test-owner", unwatch);

			const pushChannel = new PushChannel({ token });
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
			return { baseUrl: `http://127.0.0.1:${port}`, pushUrl: `ws://127.0.0.1:${port}/push`, token, pushChannel };
		}

		it("a real resource change, published by the provider directly to the returned topic, drives a push-triggered refresh", async () => {
			const { baseUrl, pushUrl, token, pushChannel } = startServer();
			const client = new RemoteVehicleClient({ baseUrl, token });

			let refreshCount = 0;
			let lastTarget: VehicleWatchTarget | undefined;
			const handle = startWatchedRefresh({
				watch: async () => {
					const target = await client.invoke<VehicleWatchTarget>("resource.watch", 1, { resource: "task-1" });
					lastTarget = target;
					return target;
				},
				resolvePushTarget: () => ({ url: pushUrl, token }),
				refresh: () => {
					refreshCount++;
				},
				pollIntervalMs: 5_000, // long enough that any refresh beyond the immediate one is push-driven, not poll-driven
			});

			// Let watch() resolve and the push connection open + subscribe.
			for (let i = 0; i < 50 && !lastTarget; i++) await sleep(10);
			expect(lastTarget).toBeDefined();
			await sleep(30);

			const beforePush = refreshCount;
			pushChannel.publish(vehicleWatchTopic(lastTarget!.watchId), { changed: true });
			await sleep(30);

			expect(refreshCount).toBeGreaterThan(beforePush);
			handle.stop();
		});

		it("polling alone still refreshes when the push target never resolves, even though a watch is otherwise reachable", async () => {
			const { baseUrl, token } = startServer();
			const client = new RemoteVehicleClient({ baseUrl, token });

			let refreshCount = 0;
			const handle = startWatchedRefresh({
				watch: async () => client.invoke<VehicleWatchTarget>("resource.watch", 1, { resource: "task-1" }),
				resolvePushTarget: () => undefined, // e.g. the push channel URL genuinely isn't resolvable in this environment
				refresh: () => {
					refreshCount++;
				},
				pollIntervalMs: 15,
			});

			await sleep(60);
			handle.stop();

			expect(refreshCount).toBeGreaterThanOrEqual(3);
		});
	});
});
