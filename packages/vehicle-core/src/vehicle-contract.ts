import type { VehicleJobWakeBudget } from "./vehicle-jobs.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonSchema = Readonly<Record<string, JsonValue>>;

export interface VehicleSchemaIssue {
	readonly path: readonly (string | number)[];
	readonly message: string;
}

export type VehicleSchemaResult<T> =
	| { readonly success: true; readonly value: T }
	| { readonly success: false; readonly issues?: readonly VehicleSchemaIssue[] };

export interface VehicleSchemaCodec<T> {
	readonly jsonSchema: JsonSchema;
	safeParse(value: unknown): VehicleSchemaResult<T>;
}

export function defineVehicleSchema<T>(codec: VehicleSchemaCodec<T>): VehicleSchemaCodec<T> {
	return Object.freeze({
		jsonSchema: cloneJson(codec.jsonSchema),
		safeParse: codec.safeParse,
	});
}

export interface LooseObjectProperty {
	readonly type: string;
	readonly enum?: readonly string[];
}

/**
 * A VehicleRegistry only ever calls a schema's own safeParse -- jsonSchema is
 * descriptive metadata surfaced to a client/Pi projection, never itself
 * enforced at runtime -- so a declared `enum` has to be checked here for
 * real, or it's a documentation gesture, not an honest contract. Every
 * consumer projecting a plain-object input onto a VehicleOperation needs the
 * same required/enum checks; this is that check written once.
 */
export function defineLooseObjectSchema(
	properties: Record<string, LooseObjectProperty>,
	required: readonly string[] = [],
): VehicleSchemaCodec<Record<string, unknown>> {
	return defineVehicleSchema<Record<string, unknown>>({
		// LooseObjectProperty's named fields (type, enum) are all JSON-value-shaped
		// at runtime, but TypeScript's structural check against the recursive
		// JsonValue union doesn't see that through a plain interface -- the cast
		// is a type-system limitation, not a runtime concern.
		jsonSchema: { type: "object", properties: properties as unknown as JsonValue, required: [...required], additionalProperties: false },
		safeParse(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return { success: false, issues: [{ path: [], message: "input must be an object" }] };
			}
			const input = value as Record<string, unknown>;
			for (const key of required) {
				if (!(key in input)) return { success: false, issues: [{ path: [key], message: `${key} is required` }] };
			}
			for (const [key, schema] of Object.entries(properties)) {
				if (!schema.enum || !(key in input)) continue;
				if (!schema.enum.includes(input[key] as string)) {
					return { success: false, issues: [{ path: [key], message: `${key} must be one of ${schema.enum.join(", ")}` }] };
				}
			}
			return { success: true, value: input };
		},
	});
}

/** Accepts any value unvalidated -- for an operation whose output shape isn't worth a dedicated schema (an internal/low-stakes result, or one already validated upstream by the domain logic it wraps). */
export const passthroughVehicleSchema: VehicleSchemaCodec<unknown> = defineVehicleSchema<unknown>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value }),
});

/**
 * A block of narrative text meant to be read by the model, not parsed as
 * data -- same field name and shape MCP's own CallToolResult.content and
 * Pi's own ToolDefinition.execute() return already use, so a Vehicle
 * operation adopting this needs no translation layer at either boundary.
 * Only the "text" variant exists here; there's no Vehicle use case yet for
 * MCP's image/audio/resource-link block kinds.
 */
export interface VehicleContentBlock {
	readonly type: "text";
	readonly text: string;
}

/**
 * An operation's Output type can intersect this to carry its own
 * model-facing narrative alongside its structured data, e.g.
 * `type RunOutput = { runId: string; created: Task[] } & WithVehicleContent`.
 * The operation itself builds `content` since it's the only code that
 * actually knows how to describe what it computed -- never a per-consumer
 * override bolted on wherever the operation happens to get registered.
 */
export interface WithVehicleContent {
	readonly content?: readonly VehicleContentBlock[];
}

/**
 * Reads an operation's own `content` blocks off its output when present and
 * well-formed, so a generic Vehicle client can prefer them over dumping raw
 * JSON at the model -- without knowing anything about the operation's own
 * domain shape. Returns undefined for a malformed or absent `content` field;
 * the caller falls back to its own default (formatted JSON) rather than
 * risk forwarding partial/garbled blocks.
 */
export function extractVehicleContent(output: unknown): readonly VehicleContentBlock[] | undefined {
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	const content = (output as { readonly content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const blocks: VehicleContentBlock[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) return undefined;
		const { type, text } = block as { readonly type?: unknown; readonly text?: unknown };
		if (type !== "text" || typeof text !== "string") return undefined;
		blocks.push({ type: "text", text });
	}
	return blocks;
}

export type VehicleEffect = "read" | "local-write" | "external-write" | "destructive" | "open-world";

export type VehicleIdempotency =
	| { readonly mode: "safe" }
	| { readonly mode: "keyed"; readonly retentionMs: number }
	| { readonly mode: "unsafe" };

export interface VehicleLimits {
	readonly defaultTimeoutMs: number;
	readonly maxTimeoutMs: number;
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
}

export interface VehicleFailureDescriptor {
	readonly code: string;
	readonly description: string;
}

/** Declares an operation safe to run as a Vehicle Job (detached, polled/tailed/canceled by id). Absent means live-invoke only. */
export interface VehicleBackgroundCapability {
	readonly supported: true;
	readonly defaultWakeBudget: VehicleJobWakeBudget;
	readonly maxWakeBudget: VehicleJobWakeBudget;
}

export interface VehicleOperationDescriptor {
	readonly name: string;
	readonly version: number;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly outputSchema: JsonSchema;
	readonly permissions: readonly string[];
	readonly effect: VehicleEffect;
	readonly idempotency: VehicleIdempotency;
	readonly streaming: boolean;
	readonly longRunning: boolean;
	readonly limits: VehicleLimits;
	readonly errors: readonly VehicleFailureDescriptor[];
	readonly background?: VehicleBackgroundCapability;
}

export interface VehicleOperation<Input, Output> {
	readonly descriptor: VehicleOperationDescriptor;
	readonly input: VehicleSchemaCodec<Input>;
	readonly output: VehicleSchemaCodec<Output>;
}

export interface DefineVehicleOperationOptions<Input, Output> {
	readonly name: string;
	readonly version: number;
	readonly description: string;
	readonly input: VehicleSchemaCodec<Input>;
	readonly output: VehicleSchemaCodec<Output>;
	readonly permissions?: readonly string[];
	readonly effect: VehicleEffect;
	readonly idempotency: VehicleIdempotency;
	readonly streaming?: boolean;
	readonly longRunning?: boolean;
	readonly limits: VehicleLimits;
	readonly errors?: readonly VehicleFailureDescriptor[];
	readonly background?: VehicleBackgroundCapability;
}

export interface VehiclePrincipal {
	readonly id: string;
	readonly claims?: Readonly<Record<string, JsonValue>>;
}

export interface VehicleInvocationOptions {
	readonly operationId?: string;
	readonly correlationId?: string;
	readonly signal?: AbortSignal;
	readonly deadline?: number;
	readonly permissions?: readonly string[];
	readonly principal?: VehiclePrincipal;
	readonly idempotencyKey?: string;
	readonly expectedRevision?: string | number;
	readonly approvalCapability?: string;
	readonly onProgress?: (progress: unknown) => void;
}

export interface VehicleOperationContext<Input> {
	readonly input: Input;
	readonly operationId: string;
	readonly correlationId?: string;
	readonly signal: AbortSignal;
	readonly deadline: number;
	readonly permissions: readonly string[];
	readonly principal?: VehiclePrincipal;
	readonly idempotencyKey?: string;
	readonly expectedRevision?: string | number;
	readonly approvalCapability?: string;
	/** Set only for a job execution (VehicleJobStore.submit()); undefined for a plain invoke(). A handler that wants mid-flight input opts in with `for await (const input of context.steerInputs ?? [])`. */
	readonly steerInputs?: AsyncIterable<unknown>;
	reportProgress(progress: unknown): void;
}

export type VehicleOperationHandler<Input, Output> = (context: VehicleOperationContext<Input>) => Promise<Output>;

export interface VehicleOperationBinding<Input, Output> {
	readonly operation: VehicleOperation<Input, Output>;
	bind(): VehicleOperationHandler<Input, Output>;
}

export interface VehicleManifestIdentity {
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly guidance?: readonly string[];
}

/**
 * A manifest's own view of an operation: the static descriptor plus
 * whether it's currently usable on this particular server instance right
 * now. Availability is a runtime property of a live registry (a
 * credential got configured or removed), never baked into the static
 * descriptor defineVehicleOperation() produces -- two manifest() calls
 * against the same registry can report different availability for the
 * exact same descriptor.
 */
export interface VehicleManifestOperation extends VehicleOperationDescriptor {
	readonly available: boolean;
	readonly unavailableReason?: string;
}

export interface VehicleManifest extends VehicleManifestIdentity {
	readonly operations: readonly VehicleManifestOperation[];
}

export interface VehicleClient {
	manifest(): Promise<VehicleManifest>;
	invoke<Output = unknown>(name: string, version: number, input: unknown, options?: VehicleInvocationOptions): Promise<Output>;
	close(): Promise<void>;
}

export function defineVehicleOperation<Input, Output>(
	options: DefineVehicleOperationOptions<Input, Output>,
): VehicleOperation<Input, Output> {
	validateOperationMetadata(options);
	const descriptor: VehicleOperationDescriptor = Object.freeze({
		name: options.name,
		version: options.version,
		description: options.description,
		inputSchema: cloneJson(options.input.jsonSchema),
		outputSchema: cloneJson(options.output.jsonSchema),
		permissions: Object.freeze([...(options.permissions ?? [])]),
		effect: options.effect,
		idempotency: Object.freeze({ ...options.idempotency }),
		streaming: options.streaming ?? false,
		longRunning: options.longRunning ?? false,
		limits: Object.freeze({ ...options.limits }),
		errors: Object.freeze((options.errors ?? []).map((failure) => Object.freeze({ ...failure }))),
		...(options.background
			? {
					background: Object.freeze({
						supported: true as const,
						defaultWakeBudget: Object.freeze({ ...options.background.defaultWakeBudget }),
						maxWakeBudget: Object.freeze({ ...options.background.maxWakeBudget }),
					}),
				}
			: {}),
	});
	return Object.freeze({ descriptor, input: options.input, output: options.output });
}

export function bindVehicleOperation<Input, Output>(
	operation: VehicleOperation<Input, Output>,
	bind: () => VehicleOperationHandler<Input, Output>,
): VehicleOperationBinding<Input, Output> {
	return Object.freeze({ operation, bind });
}

function validateOperationMetadata<Input, Output>(options: DefineVehicleOperationOptions<Input, Output>): void {
	if (!options.name.trim()) throw new Error("Vehicle operation name must not be empty");
	if (!Number.isInteger(options.version) || options.version < 1) {
		throw new Error("Vehicle operation version must be a positive integer");
	}
	if (!options.description.trim()) throw new Error("Vehicle operation description must not be empty");
	for (const permission of options.permissions ?? []) {
		if (!permission.trim()) throw new Error("Vehicle operation permissions must not contain an empty value");
	}
	const limits = options.limits;
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Vehicle operation ${name} must be a positive integer`);
	}
	if (limits.defaultTimeoutMs > limits.maxTimeoutMs) {
		throw new Error("Vehicle operation defaultTimeoutMs must not exceed maxTimeoutMs");
	}
	if (
		options.idempotency.mode === "keyed" &&
		(!Number.isSafeInteger(options.idempotency.retentionMs) || options.idempotency.retentionMs < 1)
	) {
		throw new Error("Vehicle keyed idempotency retentionMs must be a positive integer");
	}
	if (options.background) {
		if (!options.longRunning) {
			throw new Error("Vehicle operation with a background capability must also set longRunning: true");
		}
		for (const [budgetName, budget] of [
			["defaultWakeBudget", options.background.defaultWakeBudget],
			["maxWakeBudget", options.background.maxWakeBudget],
		] as const) {
			if (!Number.isSafeInteger(budget.maxCount) || budget.maxCount < 1) {
				throw new Error(`Vehicle operation background.${budgetName}.maxCount must be a positive integer`);
			}
			if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) {
				throw new Error(`Vehicle operation background.${budgetName}.maxBytes must be a positive integer`);
			}
		}
		if (options.background.defaultWakeBudget.maxCount > options.background.maxWakeBudget.maxCount) {
			throw new Error("Vehicle operation background.defaultWakeBudget.maxCount must not exceed maxWakeBudget.maxCount");
		}
		if (options.background.defaultWakeBudget.maxBytes > options.background.maxWakeBudget.maxBytes) {
			throw new Error("Vehicle operation background.defaultWakeBudget.maxBytes must not exceed maxWakeBudget.maxBytes");
		}
	}
}

function cloneJson<T extends JsonValue>(value: T): T {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Vehicle JSON metadata must be serializable");
	return freezeJson(JSON.parse(serialized) as JsonValue) as T;
}

function freezeJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
	if (value !== null && typeof value === "object") {
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeJson(child)])));
	}
	return value;
}
