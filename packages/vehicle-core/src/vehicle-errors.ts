import type { JsonValue, VehicleSchemaIssue } from "./vehicle-contract.js";

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
	/**
	 * The underlying cause's own message, when this failure wraps an unexpected error (e.g. a
	 * handler throwing something other than a VehicleError) -- bounded, never a full stack trace.
	 * Without this, a caller sees only a generic template like "x handler failed" and has no way
	 * to tell what actually went wrong or whether the underlying operation may have partially
	 * applied.
	 */
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
	/**
	 * Secure by default (false): `cause` is always attached to the real in-process Error chain
	 * (for server-side logging/observability), but its message crosses the wire via
	 * toFailure().causeMessage only when the throw site explicitly opts in here -- an arbitrary
	 * cause's message could contain a credential, an internal path, or other detail the thrower
	 * never reviewed for wire-safety. Set true only when the cause is known-safe to show (e.g. a
	 * validation library's own message intended for the caller).
	 */
	readonly exposeCause?: boolean;
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
