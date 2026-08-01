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
}

export interface VehicleErrorOptions {
	readonly category: VehicleFailureCategory;
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly recovery?: VehicleRecovery;
	readonly details?: JsonValue;
	readonly operationId?: string;
	readonly cause?: unknown;
}

export class VehicleError extends Error {
	readonly category: VehicleFailureCategory;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly recovery?: VehicleRecovery;
	readonly details?: JsonValue;
	readonly operationId?: string;

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
	}

	toFailure(): VehicleFailure {
		return {
			code: this.code,
			category: this.category,
			message: this.message,
			retryable: this.retryable,
			...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
			...(this.recovery === undefined ? {} : { recovery: this.recovery }),
			...(this.details === undefined ? {} : { details: this.details }),
			...(this.operationId === undefined ? {} : { operationId: this.operationId }),
		};
	}
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
