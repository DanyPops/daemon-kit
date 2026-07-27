import { randomUUID } from "node:crypto";
import type {
	VehicleClient,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestIdentity,
	VehicleOperationBinding,
	VehicleOperationContext,
	VehicleOperationDescriptor,
	VehiclePrincipal,
	VehicleSchemaCodec,
} from "./vehicle-contract.js";
import { boundedValidationDetails, VehicleError } from "./vehicle-errors.js";

export interface VehicleExecutionRequest {
	readonly operation: VehicleOperationDescriptor;
	readonly input: unknown;
	readonly operationId: string;
	readonly correlationId?: string;
	readonly signal: AbortSignal;
	readonly deadline: number;
	readonly permissions: readonly string[];
	readonly principal?: VehiclePrincipal;
	readonly idempotencyKey?: string;
	readonly expectedRevision?: string | number;
	readonly approvalCapability?: string;
}

export interface VehicleExecutionPolicy {
	execute(request: VehicleExecutionRequest, invoke: (effectiveInput: unknown) => Promise<unknown>): Promise<unknown>;
}

interface InvocationContext {
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

interface Registration {
	readonly owner: string;
	readonly descriptor: VehicleOperationDescriptor;
	parseInput(value: unknown, operationId: string): unknown;
	parseOutput(value: unknown, operationId: string): unknown;
	invoke(input: unknown, context: InvocationContext): Promise<unknown>;
}

function operationKey(name: string, version: number): string {
	return `${name}@${version}`;
}

function parseWithSchema<T>(
	schema: VehicleSchemaCodec<T>,
	value: unknown,
	kind: "input" | "output",
	descriptor: VehicleOperationDescriptor,
	operationId: string,
): T {
	let result;
	try {
		result = schema.safeParse(value);
	} catch (error) {
		throw new VehicleError(`invalid-${kind}`, `${operationKey(descriptor.name, descriptor.version)} returned an invalid ${kind} boundary result`, {
			category: kind === "input" ? "validation" : "internal",
			operationId,
			cause: error,
		});
	}
	if (!result.success) {
		throw new VehicleError(`invalid-${kind}`, `${operationKey(descriptor.name, descriptor.version)} received invalid ${kind}`, {
			category: kind === "input" ? "validation" : "internal",
			operationId,
			details: boundedValidationDetails(result.issues),
		});
	}
	return result.value;
}

function abortError(signal: AbortSignal, deadline: number, operationId: string): VehicleError {
	const timedOut = Date.now() >= deadline || (signal.reason instanceof Error && signal.reason.name === "TimeoutError");
	return new VehicleError(timedOut ? "deadline-exceeded" : "cancelled", timedOut ? "Vehicle operation deadline exceeded" : "Vehicle operation cancelled", {
		category: timedOut ? "timeout" : "cancelled",
		retryable: false,
		operationId,
		cause: signal.reason,
	});
}

async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal, deadline: number, operationId: string): Promise<T> {
	if (signal.aborted) throw abortError(signal, deadline, operationId);
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortError(signal, deadline, operationId));
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function effectiveDeadline(descriptor: VehicleOperationDescriptor, requested: number | undefined): number {
	const now = Date.now();
	const maximum = now + descriptor.limits.maxTimeoutMs;
	return requested === undefined ? now + descriptor.limits.defaultTimeoutMs : Math.min(requested, maximum);
}

function enforcePayloadSize(
	value: unknown,
	maxBytes: number,
	kind: "request" | "response",
	key: string,
	operationId: string,
): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new VehicleError(kind === "request" ? "invalid-input" : "invalid-output", `${key} ${kind} is not JSON-serializable`, {
			category: kind === "request" ? "validation" : "internal",
			operationId,
			cause: error,
		});
	}
	if (serialized === undefined) {
		throw new VehicleError(kind === "request" ? "invalid-input" : "invalid-output", `${key} ${kind} is not JSON-serializable`, {
			category: kind === "request" ? "validation" : "internal",
			operationId,
		});
	}
	const actualBytes = new TextEncoder().encode(serialized).byteLength;
	if (actualBytes > maxBytes) {
		throw new VehicleError(kind === "request" ? "request-too-large" : "response-too-large", `${key} ${kind} exceeds its ${maxBytes}-byte limit`, {
			category: "capacity",
			operationId,
			details: { actualBytes, maxBytes },
		});
	}
}

export class VehicleRegistry {
	private readonly registrations = new Map<string, Registration>();
	private readonly identity: VehicleManifestIdentity;

	constructor(identity: VehicleManifestIdentity, private executionPolicy?: VehicleExecutionPolicy) {
		if (!identity.name.trim()) throw new Error("Vehicle name must not be empty");
		if (!identity.version.trim()) throw new Error("Vehicle version must not be empty");
		if (!identity.description.trim()) throw new Error("Vehicle description must not be empty");
		this.identity = Object.freeze({
			...identity,
			...(identity.guidance ? { guidance: Object.freeze([...identity.guidance]) } : {}),
		});
	}

	setExecutionPolicy(policy: VehicleExecutionPolicy): void {
		if (this.executionPolicy) throw new Error("Vehicle execution policy is already configured");
		this.executionPolicy = policy;
	}

	register<Input, Output>(owner: string, binding: VehicleOperationBinding<Input, Output>): void {
		if (!owner.trim()) throw new Error("Vehicle operation owner must not be empty");
		const { operation } = binding;
		const { descriptor } = operation;
		const key = operationKey(descriptor.name, descriptor.version);
		const existing = this.registrations.get(key);
		if (existing) {
			throw new VehicleError("duplicate-owner", `${key} is already owned by ${existing.owner}; ${owner} cannot also register it`, {
				category: "conflict",
			});
		}
		const handler = binding.bind();
		this.registrations.set(key, {
			owner,
			descriptor,
			parseInput: (value, operationId) => parseWithSchema(operation.input, value, "input", descriptor, operationId),
			parseOutput: (value, operationId) => parseWithSchema(operation.output, value, "output", descriptor, operationId),
			invoke: (input, context) => {
				const typedInput = parseWithSchema(operation.input, input, "input", descriptor, context.operationId);
				const handlerContext: VehicleOperationContext<Input> = { ...context, input: typedInput };
				return handler(handlerContext);
			},
		});
	}

	ownerOf(name: string, version: number): string | undefined {
		return this.registrations.get(operationKey(name, version))?.owner;
	}

	manifest(): VehicleManifest {
		return {
			...this.identity,
			operations: [...this.registrations.values()].map((registration) => registration.descriptor),
		};
	}

	async invoke(name: string, version: number, input: unknown, options: VehicleInvocationOptions = {}): Promise<unknown> {
		const operationId = options.operationId ?? randomUUID();
		const key = operationKey(name, version);
		const registration = this.registrations.get(key);
		if (!registration) {
			throw new VehicleError("not-found", `No Vehicle operation is registered for ${key}`, {
				category: "not_found",
				operationId,
			});
		}

		enforcePayloadSize(input, registration.descriptor.limits.maxRequestBytes, "request", key, operationId);
		const granted = new Set(options.permissions ?? []);
		const missing = registration.descriptor.permissions.filter((permission) => !granted.has(permission));
		if (missing.length > 0) {
			throw new VehicleError("permission-denied", `${key} requires permissions: ${missing.join(", ")}`, {
				category: "authorization",
				operationId,
				details: { missing },
			});
		}

		if (registration.descriptor.idempotency.mode === "keyed" && !options.idempotencyKey?.trim()) {
			throw new VehicleError("idempotency-key-required", `${key} requires an idempotency key`, {
				category: "validation",
				operationId,
			});
		}
		const parsedInput = registration.parseInput(input, operationId);
		const deadline = effectiveDeadline(registration.descriptor, options.deadline);
		if (deadline <= Date.now()) {
			throw new VehicleError("deadline-exceeded", `${key} deadline has already elapsed`, {
				category: "timeout",
				operationId,
			});
		}
		const signals = [AbortSignal.timeout(Math.max(1, deadline - Date.now()))];
		if (options.signal) signals.push(options.signal);
		const signal = AbortSignal.any(signals);
		const context: InvocationContext = {
			operationId,
			correlationId: options.correlationId,
			signal,
			deadline,
			permissions: Object.freeze([...(options.permissions ?? [])]),
			principal: options.principal,
			idempotencyKey: options.idempotencyKey,
			expectedRevision: options.expectedRevision,
			approvalCapability: options.approvalCapability,
			reportProgress: (progress) => {
				enforcePayloadSize(progress, registration.descriptor.limits.maxResponseBytes, "response", key, operationId);
				options.onProgress?.(progress);
			},
		};

		const invoke = async (candidate: unknown): Promise<unknown> => {
			try {
				enforcePayloadSize(candidate, registration.descriptor.limits.maxRequestBytes, "request", key, operationId);
				return await registration.invoke(candidate, context);
			} catch (error) {
				if (error instanceof VehicleError) throw error;
				if (signal.aborted) throw abortError(signal, deadline, operationId);
				throw new VehicleError("handler-failed", `${key} handler failed`, {
					category: "internal",
					operationId,
					cause: error,
				});
			}
		};
		const request: VehicleExecutionRequest = {
			operation: registration.descriptor,
			input: parsedInput,
			operationId,
			correlationId: context.correlationId,
			signal,
			deadline,
			permissions: context.permissions,
			principal: context.principal,
			idempotencyKey: context.idempotencyKey,
			expectedRevision: context.expectedRevision,
			approvalCapability: context.approvalCapability,
		};
		const pending = (async (): Promise<unknown> => {
			try {
				return this.executionPolicy ? await this.executionPolicy.execute(request, invoke) : await invoke(parsedInput);
			} catch (error) {
				if (error instanceof VehicleError) throw error;
				throw new VehicleError("policy-failed", `${key} execution policy failed`, {
					category: "internal",
					operationId,
					cause: error,
				});
			}
		})();
		const output = await awaitWithSignal(pending, signal, deadline, operationId);
		enforcePayloadSize(output, registration.descriptor.limits.maxResponseBytes, "response", key, operationId);
		return registration.parseOutput(output, operationId);
	}
}

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

	async invoke<Output = unknown>(
		name: string,
		version: number,
		input: unknown,
		options?: VehicleInvocationOptions,
	): Promise<Output> {
		this.ensureOpen();
		return await this.registry.invoke(name, version, input, options) as Output;
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
