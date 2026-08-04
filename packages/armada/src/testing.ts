import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnostic } from "./fleet/diagnostic.js";
import type { VehicleSpec } from "./fleet/manifest.js";
import { createVehicleRegistrar, type VehicleRegistrar } from "./registrar.js";
import type {
	NativeOperationOutcome,
	NativeServiceController,
	NativeServiceDescriptor,
	NativeServiceState,
	ReadinessProbe,
} from "./native/service-manager.js";
import { systemdStrategy } from "./native/systemd.js";

export type MockVehicleApplicationState = "stopped" | "starting" | "ready" | "crashed" | "exited";
export type MockVehicleReadiness = "auto" | "manual" | "timeout";

type ReadyListener = () => void;

export interface MockVehicleApplication {
	readonly name: string;
	state(): MockVehicleApplicationState;
	start(): void;
	markReady(): void;
	crash(): void;
	exitCleanly(): void;
	restart(): void;
	stop(): void;
}

class StatefulMockVehicleApplication implements MockVehicleApplication {
	private current: MockVehicleApplicationState = "stopped";
	private readonly readyListeners = new Set<ReadyListener>();

	constructor(readonly name: string) {}

	state(): MockVehicleApplicationState {
		return this.current;
	}

	start(): void {
		this.current = "starting";
	}

	markReady(): void {
		this.current = "ready";
		for (const listener of this.readyListeners) listener();
		this.readyListeners.clear();
	}

	crash(): void {
		this.current = "crashed";
	}

	exitCleanly(): void {
		this.current = "exited";
	}

	restart(): void {
		this.start();
	}

	stop(): void {
		this.current = "stopped";
	}

	onReady(listener: ReadyListener): () => void {
		this.readyListeners.add(listener);
		return () => this.readyListeners.delete(listener);
	}
}

export interface ArmadaTestHarnessOptions {
	readonly readiness?: MockVehicleReadiness;
	readonly eventWaitTimeoutMs?: number;
}

export interface ArmadaTestHarness {
	readonly root: string;
	readonly manifestPath: string;
	readonly registrar: VehicleRegistrar;
	readonly controller: NativeServiceController;
	readonly readiness: ReadinessProbe;
	application(name: string): MockVehicleApplication;
	events(): readonly string[];
	waitForEvent(event: string): Promise<void>;
	dispose(): Promise<void>;
}

function vehicleNameFromIdentity(identity: string): string {
	return identity.replace(/^armada-/, "").replace(/\.service$/, "");
}

function success(): NativeOperationOutcome {
	return { ok: true, diagnostics: [] };
}

export async function createArmadaTestHarness(options: ArmadaTestHarnessOptions = {}): Promise<ArmadaTestHarness> {
	const root = await mkdtemp(join(tmpdir(), "armada-harness-"));
	const manifestPath = join(root, "armada.json");
	const readinessMode = options.readiness ?? "auto";
	const eventWaitTimeoutMs = options.eventWaitTimeoutMs ?? 1_000;
	const eventLog: string[] = [];
	const descriptors = new Map<string, NativeServiceDescriptor>();
	const applications = new Map<string, StatefulMockVehicleApplication>();
	const eventWaiters = new Map<string, Set<() => void>>();
	let disposed = false;

	function record(event: string): void {
		eventLog.push(event);
		const waiters = eventWaiters.get(event);
		if (waiters === undefined) return;
		for (const resolve of waiters) resolve();
		eventWaiters.delete(event);
	}

	function application(name: string): StatefulMockVehicleApplication {
		const existing = applications.get(name);
		if (existing !== undefined) return existing;
		const created = new StatefulMockVehicleApplication(name);
		applications.set(name, created);
		return created;
	}

	const controller: NativeServiceController = {
		kind: "systemd",
		capabilities: systemdStrategy.capabilities,
		inspect(vehicles: readonly VehicleSpec[]) {
			const services: NativeServiceState[] = vehicles.map((vehicle) => {
				const descriptor = [...descriptors.values()].find((item) => vehicleNameFromIdentity(item.identity) === vehicle.name);
				if (descriptor === undefined) return { name: vehicle.name, status: "absent" };
				const state = application(vehicle.name).state();
				const status = state === "crashed" ? "failed" : state === "stopped" || state === "exited" ? "stopped" : "running";
				return { name: vehicle.name, status, specHash: descriptor.specHash };
			});
			return Promise.resolve({ ok: true, services, diagnostics: [] });
		},
		replaceDescriptorAtomically(descriptor) {
			descriptors.set(descriptor.identity, descriptor);
			record(`replace:${descriptor.identity}`);
			return Promise.resolve(success());
		},
		start(identity) {
			application(vehicleNameFromIdentity(identity)).start();
			record(`start:${identity}`);
			return Promise.resolve(success());
		},
		stop(identity) {
			application(vehicleNameFromIdentity(identity)).stop();
			record(`stop:${identity}`);
			return Promise.resolve(success());
		},
		remove(identity) {
			application(vehicleNameFromIdentity(identity)).stop();
			descriptors.delete(identity);
			record(`remove:${identity}`);
			return Promise.resolve(success());
		},
	};

	const readiness: ReadinessProbe = {
		waitUntilReady(vehicle) {
			const app = application(vehicle.name);
			if (readinessMode === "timeout") {
				record(`ready-timeout:${vehicle.name}`);
				return Promise.resolve({
					ok: false,
					diagnostics: [
						diagnostic("VEHICLE_READINESS_TIMEOUT", "error", `/vehicles/${vehicle.name}`, "Mock Vehicle did not become ready"),
					],
				});
			}
			if (readinessMode === "auto") {
				app.markReady();
				record(`ready:${vehicle.name}`);
				return Promise.resolve(success());
			}
			record(`ready-wait:${vehicle.name}`);
			return new Promise((resolve) => {
				app.onReady(() => {
					record(`ready:${vehicle.name}`);
					resolve(success());
				});
			});
		},
	};

	return {
		root,
		manifestPath,
		registrar: createVehicleRegistrar({ manifestPath, controller, readiness }),
		controller,
		readiness,
		application,
		events: () => [...eventLog],
		waitForEvent(event) {
			if (eventLog.includes(event)) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					eventWaiters.get(event)?.delete(onEvent);
					reject(new Error(`Timed out waiting for Armada harness event: ${event}`));
				}, eventWaitTimeoutMs);
				const onEvent = () => {
					clearTimeout(timer);
					resolve();
				};
				const waiters = eventWaiters.get(event) ?? new Set<() => void>();
				waiters.add(onEvent);
				eventWaiters.set(event, waiters);
			});
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const app of applications.values()) app.stop();
			for (const waiters of eventWaiters.values()) for (const resolve of waiters) resolve();
			eventWaiters.clear();
			await rm(root, { recursive: true, force: true });
		},
	};
}
