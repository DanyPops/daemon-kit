/**
 * Walking skeleton for a memory/persistent-context extension (the shape
 * pi-hermes-memory, pi-memory, pi-vault-mind, and others all hand-roll):
 * remember a fact under a key, recall it later, backed by real durable
 * local storage (atomic temp+rename writes, survives a crash mid-write) --
 * not an in-memory Map that forgets everything the moment the process
 * exits. Monolith Mode (no daemon) -- see the root README's "Split vs
 * Monolith" section for when you'd want the daemon-backed Split shape
 * instead (several sessions need to share one memory store).
 *
 * Rename `memory.remember`/`memory.recall` to your own domain and replace
 * the flat key->text map with your own real memory shape (embeddings,
 * structured facts, ...) once the walking skeleton proves the wiring works.
 */
import { bindVehicleOperation, createAtomicJsonWriter, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { createMonolithVehicle } from "@danypops/vehicle-client-pi/monolith";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 65_536 };

type MemoryStore = Record<string, string>;

/**
 * Durable single-file JSON store -- fine for a walking skeleton and for a
 * genuinely small number of facts; replace with a real database once you
 * outgrow "the whole store fits comfortably in memory and on one write".
 */
export function createMemoryFile(filePath: string) {
	const writer = createAtomicJsonWriter({ fs: createNodeAtomicJsonFsAdapter() });
	let cache: MemoryStore | undefined;

	async function load(): Promise<MemoryStore> {
		if (cache) return cache;
		const raw = await writer.read(filePath);
		cache = raw && typeof raw === "object" ? (raw as MemoryStore) : {};
		return cache;
	}

	return {
		async remember(key: string, text: string): Promise<void> {
			const store = await load();
			cache = { ...store, [key]: text };
			await writer.write(filePath, cache);
		},
		async recall(key: string): Promise<string | undefined> {
			const store = await load();
			return store[key];
		},
	};
}

const rememberSchema = defineVehicleSchema<{ key: string; text: string }>({
	jsonSchema: {
		type: "object",
		properties: { key: { type: "string" }, text: { type: "string" } },
		required: ["key", "text"],
		additionalProperties: false,
	},
	safeParse(value) {
		const record = value as { key?: unknown; text?: unknown } | null;
		if (typeof record !== "object" || record === null || typeof record.key !== "string" || typeof record.text !== "string") {
			return { success: false, issues: [{ path: [], message: "key and text are both required strings" }] };
		}
		return { success: true, value: record as { key: string; text: string } };
	},
});

const recallSchema = defineVehicleSchema<{ key: string }>({
	jsonSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
	safeParse(value) {
		if (typeof value !== "object" || value === null || typeof (value as { key?: unknown }).key !== "string") {
			return { success: false, issues: [{ path: ["key"], message: "key is required and must be a string" }] };
		}
		return { success: true, value: value as { key: string } };
	},
});

const jsonSchema = defineVehicleSchema<Record<string, unknown>>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> }),
});

/** Factored out from the extension's default export so this skeleton's own test suite can exercise it directly against a real VehicleRegistry, no Pi extension host needed. */
export function registerMemoryOperations(registry: VehicleRegistry, filePath: string): void {
	const memory = createMemoryFile(filePath);

	const rememberOperation = defineVehicleOperation({
		name: "memory.remember",
		version: 1,
		description: "Durably remembers a fact under a key, for recall in a later session.",
		input: rememberSchema,
		output: jsonSchema,
		permissions: [],
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		"memory",
		bindVehicleOperation(rememberOperation, () => async (context) => {
			await memory.remember(context.input.key, context.input.text);
			return { remembered: true };
		}),
	);

	const recallOperation = defineVehicleOperation({
		name: "memory.recall",
		version: 1,
		description: "Recalls a previously remembered fact by its key, or reports it was never remembered.",
		input: recallSchema,
		output: jsonSchema,
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		"memory",
		bindVehicleOperation(recallOperation, () => async (context) => {
			const text = await memory.recall(context.input.key);
			return text === undefined ? { found: false } : { found: true, text };
		}),
	);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", async () => {
		await createMonolithVehicle(
			pi,
			{ name: "memory-template", version: "1.0.0", description: "Durable remember/recall backed by local storage." },
			(registry) => registerMemoryOperations(registry, "./memory.json"),
		);
	});
}
