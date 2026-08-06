import { describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import type { VehicleClient, VehicleInvocationOptions, VehicleManifest, VehicleManifestOperation } from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerVehicleToolsWhenReady, type VehicleReadyEvent } from "../src/vehicle-pi.ts";

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function operation(name: string, overrides: Partial<VehicleManifestOperation> = {}): VehicleManifestOperation {
	return {
		name,
		version: 1,
		description: `Run ${name}.`,
		inputSchema: { type: "object", properties: { value: { type: "string" } } },
		outputSchema: { type: "object" },
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
		available: true,
		...overrides,
	};
}

function manifest(operations: readonly VehicleManifestOperation[]): VehicleManifest {
	return { name: "test-vehicle", version: "1.0.0", description: "Test Vehicle.", operations };
}

class FakeClient implements VehicleClient {
	constructor(public value: VehicleManifest) {}
	manifest(): Promise<VehicleManifest> {
		return Promise.resolve(this.value);
	}
	async invoke<Output = unknown>(_name: string, _version: number, _input: unknown, _options?: VehicleInvocationOptions): Promise<Output> {
		return { ok: true } as Output;
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
}

function fakePi() {
	const tools: ToolDefinition[] = [];
	const harness = createExtensionHarness(() => {});
	const pi: ExtensionAPI = {
		...harness.api,
		registerTool(tool: ToolDefinition) {
			harness.api.registerTool(tool);
			tools.push(tool);
		},
	} as ExtensionAPI;
	return { pi, tools, activeTools: () => [...harness.activeTools], emit: harness.emit.bind(harness) };
}

describe("registerVehicleToolsWhenReady", () => {
	it("logs client-unavailable instead of silently returning, and settles to undefined, when resolveClient() never resolves a target", async () => {
		const { pi, emit, activeTools } = fakePi();
		const events: VehicleReadyEvent[] = [];
		const ready = registerVehicleToolsWhenReady(pi, () => Promise.resolve(undefined), {
			retry: { attempts: 1 },
			log: (event) => events.push(event),
		});

		await emit("session_start");
		const result = await ready;

		expect(result).toBeUndefined();
		expect(activeTools()).toEqual([]);
		expect(events.some((e) => e.kind === "client-unavailable")).toBe(true);
		expect(events.some((e) => e.kind === "exhausted")).toBe(true);
		expect(events.every((e) => e.ctx !== undefined)).toBe(true);
	});

	it("logs client-resolution-failed instead of silently swallowing a thrown resolveClient()", async () => {
		const { pi, emit } = fakePi();
		const events: VehicleReadyEvent[] = [];
		const ready = registerVehicleToolsWhenReady(
			pi,
			() => Promise.reject(new Error("handle file unreadable")),
			{ retry: { attempts: 1 }, log: (event) => events.push(event) },
		);

		await emit("session_start");
		await ready;

		const failure = events.find((e) => e.kind === "client-resolution-failed");
		expect(failure).toBeDefined();
		expect((failure as { error: unknown }).error).toBeInstanceOf(Error);
	});

	it("logs registration-failed instead of silently swallowing a registerVehicleTools() throw", async () => {
		const { pi, emit } = fakePi();
		const client = new FakeClient(manifest([operation("issues.search")]));
		client.manifest = () => Promise.reject(new Error("daemon unreachable"));
		const events: VehicleReadyEvent[] = [];

		const ready = registerVehicleToolsWhenReady(pi, () => Promise.resolve(client), {
			retry: { attempts: 1 },
			handshake: { attempts: 1 },
			log: (event) => events.push(event),
		});

		await emit("session_start");
		const result = await ready;

		expect(result).toBeUndefined();
		expect(events.some((e) => e.kind === "registration-failed")).toBe(true);
	});

	it("retries with bounded backoff and eventually registers once resolveClient() succeeds", async () => {
		const { pi, emit, activeTools } = fakePi();
		const client = new FakeClient(manifest([operation("issues.search")]));
		let resolveAttempts = 0;
		const events: VehicleReadyEvent[] = [];

		const ready = registerVehicleToolsWhenReady(
			pi,
			() => {
				resolveAttempts++;
				return resolveAttempts < 3 ? Promise.resolve(undefined) : Promise.resolve(client);
			},
			{ retry: { attempts: 5, initialDelayMs: 1, maxDelayMs: 2 }, log: (event) => events.push(event) },
		);

		await emit("session_start");
		const result = await ready;

		expect(resolveAttempts).toBe(3);
		expect(result?.tools.map((t) => t.operationName)).toEqual(["issues.search"]);
		expect(activeTools()).toEqual(["issues_search"]);
		expect(events.filter((e) => e.kind === "client-unavailable")).toHaveLength(2);
		expect(events.some((e) => e.kind === "registered")).toBe(true);
	});

	it("gives up after exhausting attempts without throwing, logging exactly one exhausted event", async () => {
		const { pi, emit } = fakePi();
		const events: VehicleReadyEvent[] = [];

		const ready = registerVehicleToolsWhenReady(pi, () => Promise.resolve(undefined), {
			retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
			log: (event) => events.push(event),
		});

		await emit("session_start");
		await expect(ready).resolves.toBeUndefined();

		expect(events.filter((e) => e.kind === "client-unavailable")).toHaveLength(3);
		expect(events.filter((e) => e.kind === "exhausted")).toHaveLength(1);
	});

	it("passes RegisterVehicleToolsOptions through unchanged, including shell", async () => {
		const { pi, emit, activeTools } = fakePi();
		const client = new FakeClient(manifest([operation("tasks.create"), operation("docs.list")]));

		const ready = registerVehicleToolsWhenReady(pi, () => Promise.resolve(client), {
			retry: { attempts: 1 },
			shell: { coreOperations: ["tasks.create"] },
		});

		await emit("session_start");
		await ready;

		expect(activeTools().sort()).toEqual(["tasks_create", "tools_list", "tools_man"].sort());
	});
});
