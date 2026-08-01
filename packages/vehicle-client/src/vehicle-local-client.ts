/**
 * A VehicleClient that calls a same-process VehicleRegistry directly, no
 * wire involved -- for a daemon calling its own registered operations, or
 * a host embedding a provider and its consumer in one process. Depends on
 * @danypops/vehicle-server only for VehicleRegistry's type; every other
 * VehicleClient in this package (vehicle-http-client.ts) has no such
 * dependency, which is why this file is its own subpath (./local) rather
 * than folded into a shared barrel.
 */

import type { VehicleClient, VehicleInvocationOptions, VehicleManifest } from "@danypops/vehicle-core";
import { VehicleError } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";

export class LocalVehicleClient implements VehicleClient {
	private closed = false;

	constructor(private readonly registry: VehicleRegistry) {}

	// async, not a plain function returning Promise.resolve(...) -- ensureOpen()'s
	// synchronous throw must become a rejected promise like every other
	// VehicleClient method (invoke() below is already async for the same
	// reason), not escape as a synchronous exception a caller's .catch()
	// would never see. Found live via the shared local/HTTP conformance
	// suite: RemoteVehicleClient's manifest() is async and rejects correctly,
	// which is what exposed this one not doing the same.
	async manifest(): Promise<VehicleManifest> {
		this.ensureOpen();
		return this.registry.manifest();
	}

	async invoke<Output = unknown>(name: string, version: number, input: unknown, options?: VehicleInvocationOptions): Promise<Output> {
		this.ensureOpen();
		return (await this.registry.invoke(name, version, input, options)) as Output;
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}

	private ensureOpen(): void {
		if (this.closed) {
			throw new VehicleError("client-closed", "Vehicle client is closed", {
				category: "unavailable",
			});
		}
	}
}
