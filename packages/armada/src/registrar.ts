/**
 * registrar.ts — the one high-level call a library consumer needs to make
 * Armada aware of a Vehicle and bring it to its declared state: upsert the
 * manifest, then reconcile the whole fleet against it, in-process. Composes
 * this package's own fleet/native primitives (already exported individually
 * via index.ts) the same way cli.ts's own upsert+reconcile and remove+
 * reconcile command pairs do, so a consumer (e.g. Packed's daemon-service
 * install/restart) never has to hand-assemble manifest-store + planner +
 * reconciler + a native controller itself, or shell out to this package's
 * own CLI as a subprocess to get the same effect.
 */
import { defaultManifestPath, managerKind } from "./cli.js";
import type { Diagnostic } from "./fleet/diagnostic.js";
import type { ManifestHash } from "./fleet/identity.js";
import type { ArmadaManifest, VehicleRestartPolicy, VehicleResources } from "./fleet/manifest.js";
import { readManifestFile, removeManifestVehicle, upsertManifestVehicle } from "./fleet/manifest-store.js";
import { type PlanOperation, planFleet } from "./fleet/planner.js";
import { createHandleReadinessProbe } from "./fleet/readiness.js";
import { reconcileFleet } from "./fleet/reconciler.js";
import { createNativeController, defaultDescriptorRoot, strategyForNativeManager } from "./native/controller.js";
import type { NativeServiceController, ReadinessProbe } from "./native/service-manager.js";

/** Pre-validation input shape for register() -- name/executable/handlePath are plain strings here; upsertManifestVehicle's own decodeArmadaManifest is still the single source of truth for validating and branding them. */
export interface VehicleRegistrationInput {
	readonly name: string;
	readonly version: string;
	readonly executable: string;
	readonly arguments?: readonly string[];
	readonly workingDirectory?: string;
	readonly handlePath: string;
	readonly restart: VehicleRestartPolicy;
	readonly readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number };
	readonly resources?: VehicleResources;
}

export type VehicleRegistrationOutcome =
	| { readonly ok: true; readonly manifestHash: ManifestHash; readonly applied: readonly PlanOperation[]; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface VehicleRegistrar {
	/** Upserts the Vehicle into the manifest, then reconciles the whole fleet against it -- installs it natively if new, or stops+replaces+restarts it if its declared spec (version, executable, args, ...) drifted from what's currently running. A no-op reconcile (nothing changed) still returns ok:true with an empty applied list. */
	register(vehicle: VehicleRegistrationInput): Promise<VehicleRegistrationOutcome>;
	/** Removes the native service first, then drops the Vehicle from the manifest -- native-first so a failed native removal never leaves the manifest silently claiming a Vehicle that's actually gone. Idempotent: unregistering a name the manifest doesn't know about succeeds with an empty applied list. */
	unregister(name: string): Promise<VehicleRegistrationOutcome>;
	/** Whether the manifest currently declares this Vehicle -- registration status alone, not native running/ready state (see status.ts's buildFleetStatus for that). False on any manifest read failure, the same fail-closed default a caller deciding whether to restart/reconcile something should get. */
	isRegistered(name: string): Promise<boolean>;
}

export interface VehicleRegistrarOptions {
	readonly manifestPath?: string;
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	/** Overrides the real native controller this platform would otherwise get -- for tests, or a caller that already has one. */
	readonly controller?: NativeServiceController;
	readonly readiness?: ReadinessProbe;
}

export function createVehicleRegistrar(options: VehicleRegistrarOptions = {}): VehicleRegistrar {
	const platform = options.platform ?? process.platform;
	const manifestPath = options.manifestPath ?? defaultManifestPath(platform, options.env, options.home);
	const kind = managerKind(platform);
	const controller =
		options.controller ?? createNativeController({ kind, descriptorRoot: defaultDescriptorRoot(kind, options.env, options.home) });
	const readiness = options.readiness ?? createHandleReadinessProbe();
	const strategy = strategyForNativeManager(controller.kind);

	async function reconcileAgainst(manifest: ArmadaManifest): Promise<VehicleRegistrationOutcome> {
		const inspected = await controller.inspect(manifest.vehicles);
		if (!inspected.ok) return inspected;
		const planned = planFleet(manifest, inspected.services);
		if (!planned.ok) return planned;
		const reconciled = await reconcileFleet({
			manifest,
			plan: planned.plan,
			strategy,
			controller,
			readCurrentManifestHash: async () => {
				const current = await readManifestFile(manifestPath);
				return current.ok ? { ok: true, hash: current.manifest.contentHash } : current;
			},
			readiness,
		});
		if (!reconciled.ok) return reconciled;
		return { ok: true, manifestHash: manifest.contentHash, applied: reconciled.applied, diagnostics: reconciled.diagnostics };
	}

	return {
		async register(vehicle) {
			const upserted = await upsertManifestVehicle(manifestPath, JSON.stringify(vehicle));
			if (!upserted.ok) return upserted;
			return reconcileAgainst(upserted.manifest);
		},
		async isRegistered(name) {
			const current = await readManifestFile(manifestPath);
			return current.ok && current.manifest.vehicles.some((vehicle) => vehicle.name === name);
		},
		async unregister(name) {
			const current = await readManifestFile(manifestPath);
			if (!current.ok) return current;
			const vehicle = current.manifest.vehicles.find((item) => item.name === name);
			if (!vehicle) return { ok: true, manifestHash: current.manifest.contentHash, applied: [], diagnostics: [] };
			const generated = strategy.generateDescriptor(vehicle);
			if (!generated.ok) return generated;
			const removedNative = await controller.remove(generated.descriptor.identity);
			if (!removedNative.ok) return removedNative;
			const removedManifest = await removeManifestVehicle(manifestPath, name);
			if (!removedManifest.ok) return removedManifest;
			return {
				ok: true,
				manifestHash: removedManifest.manifest.contentHash,
				applied: [],
				diagnostics: [...removedNative.diagnostics, ...removedManifest.diagnostics],
			};
		},
	};
}
