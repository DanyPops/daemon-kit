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
	invoke<Output = unknown>(
		name: string,
		version: number,
		input: unknown,
		options?: VehicleInvocationOptions,
	): Promise<Output>;
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
	if (options.idempotency.mode === "keyed" && (!Number.isSafeInteger(options.idempotency.retentionMs) || options.idempotency.retentionMs < 1)) {
		throw new Error("Vehicle keyed idempotency retentionMs must be a positive integer");
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
