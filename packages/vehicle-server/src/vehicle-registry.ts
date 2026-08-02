import { randomUUID } from "node:crypto";
import type {
	VehicleBackgroundCapability,
	VehicleEvent,
	VehicleEventDescriptor,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestIdentity,
	VehicleOperationBinding,
	VehicleOperationContext,
	VehicleOperationDescriptor,
	VehiclePrincipal,
	VehicleSchemaCodec,
	VehicleSchemaResult,
} from "@danypops/vehicle-core";
import { boundedValidationDetails, vehicleEventTopic, VehicleError } from "@danypops/vehicle-core";

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

interface EventRegistration {
	readonly owner: string;
	readonly descriptor: VehicleEventDescriptor;
	parsePayload(value: unknown, eventId: string): unknown;
	readonly listeners: Set<(payload: unknown) => void>;
}

/** A publish(topic, payload) sink -- PushChannel satisfies this structurally with zero import needed; see bridgeVehicleEventsToPushChannel below. */
export interface VehicleEventPublisher {
	publish(topic: string, payload: unknown): void;
}

function operationKey(name: string, version: number): string {
	return `${name}@${version}`;
}

function eventKey(name: string, version: number): string {
	return `${name}@${version}`;
}

/** Bounds a single event's local listener set the same way PushChannel bounds its own connections/topics -- defense in depth against an unbounded subscribe() loop, not a limit any real single-bridge-plus-a-few-widgets usage should ever approach. */
const MAX_LISTENERS_PER_EVENT = 64;

function parseWithSchema<T>(
	schema: VehicleSchemaCodec<T>,
	value: unknown,
	kind: "input" | "output",
	descriptor: VehicleOperationDescriptor,
	operationId: string,
): T {
	let result: VehicleSchemaResult<T>;
	try {
		result = schema.safeParse(value);
	} catch (error) {
		throw new VehicleError(
			`invalid-${kind}`,
			`${operationKey(descriptor.name, descriptor.version)} returned an invalid ${kind} boundary result`,
			{
				category: kind === "input" ? "validation" : "internal",
				operationId,
				cause: error,
			},
		);
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

function parseEventPayload<T>(schema: VehicleSchemaCodec<T>, value: unknown, descriptor: VehicleEventDescriptor, eventId: string): T {
	let result: VehicleSchemaResult<T>;
	const key = eventKey(descriptor.name, descriptor.version);
	try {
		result = schema.safeParse(value);
	} catch (error) {
		throw new VehicleError("invalid-payload", `${key} received an invalid event payload`, {
			category: "validation",
			operationId: eventId,
			cause: error,
		});
	}
	if (!result.success) {
		throw new VehicleError("invalid-payload", `${key} received an invalid event payload`, {
			category: "validation",
			operationId: eventId,
			details: boundedValidationDetails(result.issues),
		});
	}
	return result.value;
}

function abortError(signal: AbortSignal, deadline: number, operationId: string): VehicleError {
	const timedOut = Date.now() >= deadline || (signal.reason instanceof Error && signal.reason.name === "TimeoutError");
	return new VehicleError(
		timedOut ? "deadline-exceeded" : "cancelled",
		timedOut ? "Vehicle operation deadline exceeded" : "Vehicle operation cancelled",
		{
			category: timedOut ? "timeout" : "cancelled",
			retryable: false,
			operationId,
			cause: signal.reason,
		},
	);
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

function enforcePayloadSize(value: unknown, maxBytes: number, kind: "request" | "response", key: string, operationId: string): void {
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
		throw new VehicleError(
			kind === "request" ? "request-too-large" : "response-too-large",
			`${key} ${kind} exceeds its ${maxBytes}-byte limit`,
			{
				category: "capacity",
				operationId,
				details: { actualBytes, maxBytes },
			},
		);
	}
}

interface AvailabilityState {
	readonly available: boolean;
	readonly reason?: string;
}

export interface VehicleBackgroundResolutionOptions {
	readonly operationId?: string;
	readonly correlationId?: string;
	readonly permissions?: readonly string[];
	readonly principal?: VehiclePrincipal;
	readonly idempotencyKey?: string;
	readonly expectedRevision?: string | number;
	readonly approvalCapability?: string;
}

/** Everything VehicleJobStore needs to run a background op detached: validated descriptor/capability, parsed input, and a run() that validates the result like invoke() does. */
export interface VehicleBackgroundResolution {
	readonly descriptor: VehicleOperationDescriptor;
	readonly background: VehicleBackgroundCapability;
	readonly operationId: string;
	readonly parsedInput: unknown;
	run(context: VehicleOperationContext<unknown>): Promise<unknown>;
}

export class VehicleRegistry {
	private readonly registrations = new Map<string, Registration>();
	private readonly availability = new Map<string, AvailabilityState>();
	private readonly identity: VehicleManifestIdentity;
	private readonly events = new Map<string, EventRegistration>();
	private readonly wildcardListeners = new Set<(name: string, version: number, payload: unknown) => void>();

	constructor(
		identity: VehicleManifestIdentity,
		private executionPolicy?: VehicleExecutionPolicy,
	) {
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

	/** Declares a named, schema'd event type a handler can later emit() -- the typed replacement for a raw PushChannel.publish() call with a hand-invented topic string. */
	registerEvent<Payload>(owner: string, event: VehicleEvent<Payload>): void {
		if (!owner.trim()) throw new Error("Vehicle event owner must not be empty");
		const { descriptor } = event;
		const key = eventKey(descriptor.name, descriptor.version);
		const existing = this.events.get(key);
		if (existing) {
			throw new VehicleError("duplicate-owner", `${key} is already owned by ${existing.owner}; ${owner} cannot also register it`, {
				category: "conflict",
			});
		}
		this.events.set(key, {
			owner,
			descriptor,
			parsePayload: (value, eventId) => parseEventPayload(event.payload, value, descriptor, eventId),
			listeners: new Set(),
		});
	}

	/**
	 * Validates payload against the declared event's own schema and byte-size
	 * limit (same bounded-resource discipline invoke() applies to a
	 * request/response), then notifies every current local listener --
	 * both a direct subscribeLocal() caller (LocalVehicleClient) and any
	 * wildcard bridge (subscribeAll(), e.g. bridgeVehicleEventsToPushChannel
	 * for remote delivery). A throwing listener is swallowed so one bad
	 * subscriber can never break emit() for every other subscriber or the
	 * handler that's emitting.
	 */
	emit(name: string, version: number, payload: unknown): void {
		const key = eventKey(name, version);
		const registration = this.events.get(key);
		if (!registration) {
			throw new VehicleError("not-found", `No Vehicle event is registered for ${key}`, { category: "not_found" });
		}
		const eventId = randomUUID();
		const parsed = registration.parsePayload(payload, eventId);
		enforcePayloadSize(parsed, registration.descriptor.maxPayloadBytes, "response", key, eventId);
		for (const listener of registration.listeners) {
			try {
				listener(parsed);
			} catch {
				// Best-effort fan-out -- see the doc comment above.
			}
		}
		for (const listener of this.wildcardListeners) {
			try {
				listener(name, version, parsed);
			} catch {
				// Best-effort fan-out -- see the doc comment above.
			}
		}
	}

	/** In-process subscription to one declared event, scoped to a caller that already knows its exact name/version -- what LocalVehicleClient.subscribe() is built on. Throws not-found the same way invoke() does for an unregistered operation, rather than silently listening for something that can never fire. */
	subscribeLocal(name: string, version: number, listener: (payload: unknown) => void): () => void {
		const key = eventKey(name, version);
		const registration = this.events.get(key);
		if (!registration) {
			throw new VehicleError("not-found", `No Vehicle event is registered for ${key}`, { category: "not_found" });
		}
		if (registration.listeners.size >= MAX_LISTENERS_PER_EVENT) {
			throw new VehicleError("capacity-exceeded", `${key} already has the maximum of ${MAX_LISTENERS_PER_EVENT} local listeners`, {
				category: "capacity",
			});
		}
		registration.listeners.add(listener);
		return () => registration.listeners.delete(listener);
	}

	/** Every current and future emit(), regardless of event name -- the seam bridgeVehicleEventsToPushChannel uses so a bridge set up once forwards every event a provider declares, including ones registered after the bridge itself. */
	subscribeAll(listener: (name: string, version: number, payload: unknown) => void): () => void {
		this.wildcardListeners.add(listener);
		return () => this.wildcardListeners.delete(listener);
	}

	/**
	 * Marks a registered operation available or unavailable on this running
	 * instance -- e.g. a provider whose credential just got configured or
	 * removed. There is no unregister(): an operation's shape is permanent
	 * once registered (mirroring Pi's own tool model, which has no
	 * unregisterTool() either), only its usability toggles. invoke() refuses
	 * an unavailable operation; manifest() reports it with available:false so
	 * a client-side projection (see vehicle-pi.ts) can hide it from the LLM
	 * before ever attempting a call.
	 */
	setAvailability(name: string, version: number, available: boolean, reason?: string): void {
		const key = operationKey(name, version);
		if (!this.registrations.has(key)) throw new Error(`Cannot set availability for unregistered Vehicle operation ${key}`);
		this.availability.set(key, { available, reason });
	}

	manifest(): VehicleManifest {
		return {
			...this.identity,
			operations: [...this.registrations.values()].map((registration) => {
				const key = operationKey(registration.descriptor.name, registration.descriptor.version);
				const state = this.availability.get(key);
				return {
					...registration.descriptor,
					available: state?.available ?? true,
					...(state?.reason ? { unavailableReason: state.reason } : {}),
				};
			}),
			events: [...this.events.values()].map((registration) => registration.descriptor),
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
		const availability = this.availability.get(key);
		if (availability?.available === false) {
			throw new VehicleError("operation-unavailable", availability.reason ?? `${key} is currently unavailable`, {
				category: "unavailable",
				operationId,
				retryable: true,
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

	/** Same validation as invoke(), minus awaiting the handler -- the seam VehicleJobStore needs. Kept separate so it can't regress invoke()'s tested behavior. */
	resolveForBackground(
		name: string,
		version: number,
		input: unknown,
		options: VehicleBackgroundResolutionOptions = {},
	): VehicleBackgroundResolution {
		const operationId = options.operationId ?? randomUUID();
		const key = operationKey(name, version);
		const registration = this.registrations.get(key);
		if (!registration) {
			throw new VehicleError("not-found", `No Vehicle operation is registered for ${key}`, { category: "not_found", operationId });
		}
		const background = registration.descriptor.background;
		if (!background) {
			throw new VehicleError("background-not-supported", `${key} does not support background execution`, {
				category: "validation",
				operationId,
			});
		}
		const availability = this.availability.get(key);
		if (availability?.available === false) {
			throw new VehicleError("operation-unavailable", availability.reason ?? `${key} is currently unavailable`, {
				category: "unavailable",
				operationId,
				retryable: true,
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

		return Object.freeze({
			descriptor: registration.descriptor,
			background,
			operationId,
			parsedInput,
			run: async (context: VehicleOperationContext<unknown>): Promise<unknown> => {
				let output: unknown;
				try {
					output = await registration.invoke(parsedInput, context);
				} catch (error) {
					if (error instanceof VehicleError) throw error;
					if (context.signal.aborted) throw abortError(context.signal, context.deadline, operationId);
					throw new VehicleError("handler-failed", `${key} handler failed`, { category: "internal", operationId, cause: error });
				}
				enforcePayloadSize(output, registration.descriptor.limits.maxResponseBytes, "response", key, operationId);
				return registration.parseOutput(output, operationId);
			},
		});
	}
}

/**
 * Forwards every event a registry emits onto a PushChannel-shaped publish
 * sink, under the shared vehicleEventTopic() naming convention
 * RemoteVehicleClient.subscribe() expects -- the remote-delivery half of
 * Vehicle Events. Call once at composition-root time, after the registry's
 * providers have registered (or before -- subscribeAll() catches every
 * future emit() too, regardless of registration order). Returns a teardown
 * matching subscribeAll()'s own unsubscribe shape.
 *
 * Takes a structural VehicleEventPublisher, not a concrete PushChannel
 * import -- PushChannel already satisfies this with its own publish()
 * method, so a daemon wires this as
 * `bridgeVehicleEventsToPushChannel(registry, pushChannel)` with zero
 * extra glue, while this file itself stays free of a cross-build-config
 * dependency on push-channel.ts (a separate tsconfig entry point).
 */
export function bridgeVehicleEventsToPushChannel(registry: VehicleRegistry, publisher: VehicleEventPublisher): () => void {
	return registry.subscribeAll((name, version, payload) => {
		publisher.publish(vehicleEventTopic(name, version), payload);
	});
}
