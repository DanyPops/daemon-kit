/**
 * Host-neutral conformance suite: one shared set of assertions that any
 * VehicleClient implementation (LocalVehicleClient, RemoteVehicleClient,
 * and any future MCP/CLI projection) must satisfy identically. Registers
 * its own fixed set of test operations onto whatever registry the fixture
 * hands back, so the *same* operation definitions exercise every
 * implementation -- two independently hand-written test files could drift
 * apart without either one noticing; a shared suite can't.
 *
 * Deliberately built on bun:test directly (not a framework-agnostic DSL) --
 * every consumer of this package that would run it is already a Bun
 * project, and inventing a test-runner abstraction for a single-runtime
 * ecosystem would be pure ceremony.
 *
 * A fixture only supplies a fresh, isolated registry + a client bound to
 * it + cleanup -- it does not define operations or assertions itself, so
 * host-specific concerns (Alef's bus/context/display assertions, a CLI's
 * argument parsing) stay out of this module entirely, per the extraction
 * scope this generalizes.
 */
import { describe, expect, it } from "bun:test";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema, VehicleError } from "@danypops/vehicle-core";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";

const passthroughSchema = defineVehicleSchema<{ value: string }>({
	jsonSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
	safeParse(value: unknown) {
		if (typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "string") {
			return { success: true, value: value as { value: string } };
		}
		return { success: false, issues: [{ path: ["value"], message: "value must be a string" }] };
	},
});

const outputSchema = defineVehicleSchema<{ echoed: string }>({
	jsonSchema: { type: "object", properties: { echoed: { type: "string" } }, additionalProperties: false },
	safeParse(value: unknown) {
		if (typeof value === "object" && value !== null && typeof (value as { echoed?: unknown }).echoed === "string") {
			return { success: true, value: value as { echoed: string } };
		}
		return { success: false, issues: [{ path: ["echoed"], message: "echoed must be a string" }] };
	},
});

const LIMITS = { defaultTimeoutMs: 200, maxTimeoutMs: 2_000, maxRequestBytes: 256, maxResponseBytes: 256 } as const;

const ConformanceEcho = defineVehicleOperation({
	name: "conformance.echo",
	version: 1,
	description: "Echoes its input.",
	input: passthroughSchema,
	output: outputSchema,
	permissions: ["conformance:echo"],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

const ConformanceBoom = defineVehicleOperation({
	name: "conformance.boom",
	version: 1,
	description: "Always throws a real VehicleError from its handler.",
	input: passthroughSchema,
	output: outputSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

const ConformanceKeyed = defineVehicleOperation({
	name: "conformance.keyed",
	version: 1,
	description: "Requires a keyed idempotency key.",
	input: passthroughSchema,
	output: outputSchema,
	permissions: [],
	effect: "external-write",
	idempotency: { mode: "keyed", retentionMs: 60_000 },
	limits: LIMITS,
});

const ConformanceProgress = defineVehicleOperation({
	name: "conformance.progress",
	version: 1,
	description: "Reports two progress events, then resolves.",
	input: passthroughSchema,
	output: outputSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

const ConformanceNever = defineVehicleOperation({
	name: "conformance.never",
	version: 1,
	description: "Never resolves on its own -- only via cancellation or deadline.",
	input: passthroughSchema,
	output: outputSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

/** Registers the fixed conformance operation set onto `registry`. Every fixture must call this before handing back its client. */
export function registerConformanceOperations(registry: VehicleRegistry): void {
	registry.register(
		"conformance",
		bindVehicleOperation(ConformanceEcho, () => async (context) => ({ echoed: context.input.value })),
	);
	registry.register(
		"conformance",
		bindVehicleOperation(ConformanceBoom, () => async () => {
			throw new VehicleError("conformance-boom", "conformance.boom always fails", { category: "internal" });
		}),
	);
	registry.register(
		"conformance",
		bindVehicleOperation(ConformanceKeyed, () => async (context) => ({ echoed: context.input.value })),
	);
	registry.register(
		"conformance",
		bindVehicleOperation(ConformanceProgress, () => async (context) => {
			context.reportProgress({ step: 1 });
			context.reportProgress({ step: 2 });
			return { echoed: context.input.value };
		}),
	);
	registry.register(
		"conformance",
		bindVehicleOperation(ConformanceNever, () => (context) => {
			return new Promise((_resolve, reject) => {
				context.signal.addEventListener("abort", () => reject(new Error("conformance.never aborted")), { once: true });
			});
		}),
	);
}

export interface VehicleConformanceFixture {
	/** Used in describe() block titles, e.g. "LocalVehicleClient" or "RemoteVehicleClient (HTTP)". */
	label: string;
	/** Builds a fresh, isolated registry (with registerConformanceOperations already applied) plus a client bound to it. Must not share state across calls -- each test gets its own. */
	create(): Promise<{ client: VehicleClient; cleanup: () => Promise<void> }>;
}

export function runVehicleClientConformance(fixture: VehicleConformanceFixture): void {
	describe(`Vehicle client conformance: ${fixture.label}`, () => {
		it("manifest() lists every registered operation with its real descriptor fields", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				const manifest = await client.manifest();
				const names = manifest.operations.map((op) => `${op.name}@${op.version}`).sort();
				expect(names).toEqual([
					"conformance.boom@1",
					"conformance.echo@1",
					"conformance.keyed@1",
					"conformance.never@1",
					"conformance.progress@1",
				]);
				const echo = manifest.operations.find((op) => op.name === "conformance.echo");
				expect(echo?.permissions).toEqual(["conformance:echo"]);
				expect(echo?.idempotency).toEqual({ mode: "safe" });
				// available defaults to true for every operation, and must survive
				// the wire round trip identically for a remote (HTTP/JSON) client,
				// not just the in-process local one.
				expect(manifest.operations.every((op) => op.available === true)).toBe(true);
				expect(echo?.unavailableReason).toBeUndefined();
			} finally {
				await cleanup();
			}
		});

		it("invoke() returns the real handler output on success", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				const result = await client.invoke<{ echoed: string }>("conformance.echo", 1, { value: "hi" }, { permissions: ["conformance:echo"] });
				expect(result).toEqual({ echoed: "hi" });
			} finally {
				await cleanup();
			}
		});

		it("invoke() rejects invalid input before the handler ever runs", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				await expect(client.invoke("conformance.echo", 1, { value: 123 }, { permissions: ["conformance:echo"] })).rejects.toMatchObject({
					code: "invalid-input",
				});
			} finally {
				await cleanup();
			}
		});

		it("invoke() enforces required permissions with permission-denied/authorization", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				await expect(client.invoke("conformance.echo", 1, { value: "hi" }, {})).rejects.toMatchObject({
					code: "permission-denied",
					category: "authorization",
				});
			} finally {
				await cleanup();
			}
		});

		it("invoke() surfaces a real handler failure's own code/category/message, not a generic wrapper", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				await expect(client.invoke("conformance.boom", 1, { value: "x" }, {})).rejects.toMatchObject({
					code: "conformance-boom",
					message: "conformance.boom always fails",
				});
			} finally {
				await cleanup();
			}
		});

		it("invoke() requires an idempotency key for a keyed operation", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				await expect(client.invoke("conformance.keyed", 1, { value: "x" }, {})).rejects.toMatchObject({
					code: "idempotency-key-required",
				});
				const result = await client.invoke<{ echoed: string }>("conformance.keyed", 1, { value: "x" }, { idempotencyKey: "k-1" });
				expect(result).toEqual({ echoed: "x" });
			} finally {
				await cleanup();
			}
		});

		it("invoke() rejects a request exceeding its declared byte bound", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				const oversized = "x".repeat(1024);
				await expect(client.invoke("conformance.echo", 1, { value: oversized }, { permissions: ["conformance:echo"] })).rejects.toMatchObject({
					code: "request-too-large",
				});
			} finally {
				await cleanup();
			}
		});

		it("invoke() rejects an operation for a name/version pair that was never registered", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				await expect(client.invoke("conformance.nonexistent", 1, {}, {})).rejects.toMatchObject({ code: "not-found" });
			} finally {
				await cleanup();
			}
		});

		it("invoke() delivers every progress event before resolving with the final result, never after", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				const progress: unknown[] = [];
				let resolved = false;
				const result = await client.invoke<{ echoed: string }>("conformance.progress", 1, { value: "hi" }, {
					onProgress: (p) => {
						expect(resolved).toBe(false);
						progress.push(p);
					},
				});
				resolved = true;
				expect(progress).toEqual([{ step: 1 }, { step: 2 }]);
				expect(result).toEqual({ echoed: "hi" });
			} finally {
				await cleanup();
			}
		});

		it("invoke() propagates cancellation via AbortSignal to the operation itself", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				const controller = new AbortController();
				const invocation = client.invoke("conformance.never", 1, { value: "x" }, { signal: controller.signal });
				await new Promise((resolve) => setTimeout(resolve, 15));
				controller.abort();
				await expect(invocation).rejects.toBeTruthy();
			} finally {
				await cleanup();
			}
		});

		it("invoke() respects an explicit deadline that has already elapsed", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				await expect(client.invoke("conformance.echo", 1, { value: "hi" }, { permissions: ["conformance:echo"], deadline: Date.now() - 1 })).rejects.toMatchObject({
					code: "deadline-exceeded",
				});
			} finally {
				await cleanup();
			}
		});

		it("close() prevents further invoke()/manifest() calls on this client instance", async () => {
			const { client, cleanup } = await fixture.create();
			try {
				await client.close();
				await expect(client.manifest()).rejects.toBeTruthy();
			} finally {
				await cleanup();
			}
		});
	});
}
