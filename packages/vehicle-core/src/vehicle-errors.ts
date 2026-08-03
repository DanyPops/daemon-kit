import type { JsonValue, VehicleSchemaIssue } from "./vehicle-contract.js";

const VEHICLE_ERROR_BRAND = Symbol.for("@danypops/vehicle-core/VehicleError");

export type VehicleFailureCategory =
	| "validation"
	| "not_found"
	| "conflict"
	| "authorization"
	| "capacity"
	| "timeout"
	| "cancelled"
	| "unavailable"
	| "internal";

export type VehicleCoreErrorCode =
	| "duplicate-owner"
	| "not-found"
	| "invalid-input"
	| "invalid-output"
	| "permission-denied"
	| "request-too-large"
	| "response-too-large"
	| "cancelled"
	| "deadline-exceeded"
	| "handler-failed"
	| "policy-failed"
	| "idempotency-key-required"
	| "client-closed"
	| "operation-unavailable"
	| "background-not-supported"
	| "job-not-found"
	| "job-not-steerable"
	| "job-steer-queue-full";

export interface VehicleRecovery {
	readonly operation?: string;
	readonly message: string;
}

export interface VehicleFailure {
	readonly code: string;
	readonly category: VehicleFailureCategory;
	readonly message: string;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly recovery?: VehicleRecovery;
	readonly details?: JsonValue;
	readonly operationId?: string;
	/** The underlying cause's own message, bounded (never a full stack trace). Only set when the throw site opts into exposeCause. */
	readonly causeMessage?: string;
}

export interface VehicleErrorOptions {
	readonly category: VehicleFailureCategory;
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly recovery?: VehicleRecovery;
	readonly details?: JsonValue;
	readonly operationId?: string;
	readonly cause?: unknown;
	/** Includes cause's message in toFailure().causeMessage. Default false -- an arbitrary cause could carry a credential or internal detail. */
	readonly exposeCause?: boolean;
}

export type VehicleErrorClass = abstract new (...args: never[]) => Error;

export interface VehicleErrorClassMapping {
	readonly errorClass: VehicleErrorClass;
	readonly category: VehicleFailureCategory;
	readonly code?: string;
}

export interface VehicleErrorPredicateMapping {
	readonly matches: (error: unknown) => boolean;
	readonly category: VehicleFailureCategory;
	readonly code?: string;
}

export type VehicleErrorMapping = VehicleErrorClassMapping | VehicleErrorPredicateMapping;

export interface DefineErrorMappingOptions {
	readonly fallbackCategory?: VehicleFailureCategory;
	readonly fallbackCode?: string;
	readonly fallbackMessage?: string;
}

/** Maps reviewed domain errors into wire-safe Vehicle errors while preserving already-mapped failures. */
export function defineErrorMapping(
	rules: readonly VehicleErrorMapping[],
	options: DefineErrorMappingOptions = {},
): <T>(run: () => T | Promise<T>) => Promise<T> {
	return async <T>(run: () => T | Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			if (isVehicleError(error)) throw error;
			const rule = rules.find((candidate) =>
				"errorClass" in candidate ? error instanceof candidate.errorClass : candidate.matches(error),
			);
			const causeMessage = error instanceof Error ? error.message : String(error);
			const message = rule === undefined && options.fallbackMessage !== undefined ? options.fallbackMessage : causeMessage;
			const code = rule === undefined ? (options.fallbackCode ?? "operation-rejected") : (rule.code ?? "operation-rejected");
			throw new VehicleError(code, message, {
				category: rule?.category ?? options.fallbackCategory ?? "validation",
				cause: error,
			});
		}
	};
}

export class VehicleError extends Error {
	readonly category: VehicleFailureCategory;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly recovery?: VehicleRecovery;
	readonly details?: JsonValue;
	readonly operationId?: string;
	private readonly exposeCause: boolean;

	constructor(
		readonly code: string,
		message: string,
		options: VehicleErrorOptions,
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		Object.defineProperty(this, VEHICLE_ERROR_BRAND, { value: true });
		this.name = "VehicleError";
		this.category = options.category;
		this.retryable = options.retryable ?? false;
		this.retryAfterMs = options.retryAfterMs;
		this.recovery = options.recovery;
		this.details = options.details;
		this.operationId = options.operationId;
		this.exposeCause = options.exposeCause ?? false;
	}

	toFailure(): VehicleFailure {
		const causeMessage = this.exposeCause ? boundedCauseMessage(this.cause) : undefined;
		return {
			code: this.code,
			category: this.category,
			message: this.message,
			retryable: this.retryable,
			...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
			...(this.recovery === undefined ? {} : { recovery: this.recovery }),
			...(this.details === undefined ? {} : { details: this.details }),
			...(this.operationId === undefined ? {} : { operationId: this.operationId }),
			...(causeMessage === undefined ? {} : { causeMessage }),
		};
	}
}

/** Recognizes VehicleError instances across duplicated package installations in one process. */
export function isVehicleError(value: unknown): value is VehicleError {
	return value instanceof Error && Reflect.get(value, VEHICLE_ERROR_BRAND) === true;
}

const MAX_CAUSE_MESSAGE_LENGTH = 500;

/** Extracts a bounded, wire-safe message from an unknown cause -- never the full stack trace, never an unbounded payload. */
export function boundedCauseMessage(cause: unknown): string | undefined {
	if (cause instanceof Error && cause.message.length > 0) return cause.message.slice(0, MAX_CAUSE_MESSAGE_LENGTH);
	if (typeof cause === "string" && cause.length > 0) return cause.slice(0, MAX_CAUSE_MESSAGE_LENGTH);
	return undefined;
}

const MAX_VALIDATION_ISSUES = 10;
const MAX_ISSUE_MESSAGE_LENGTH = 500;
const MAX_ISSUE_PATH_LENGTH = 20;

export function boundedValidationDetails(issues: readonly VehicleSchemaIssue[] | undefined): JsonValue | undefined {
	if (!issues?.length) return undefined;
	return {
		issues: issues.slice(0, MAX_VALIDATION_ISSUES).map((issue) => ({
			path: issue.path.slice(0, MAX_ISSUE_PATH_LENGTH),
			message: issue.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH),
		})),
		...(issues.length > MAX_VALIDATION_ISSUES ? { truncated: true } : {}),
	};
}
