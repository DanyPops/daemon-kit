/**
 * Wire-level shapes for the Approval Gate: a pending human/authority decision
 * that stands between a gated-effect invoke() and its handler actually
 * running. Kept in vehicle-core (runtime-neutral, zero dependencies) --
 * the actual signing/verification authority (HmacApprovalAuthority) needs
 * node:crypto and lives in vehicle-server instead, the same split
 * atomic-json.ts already uses for fs access.
 */
import type { VehicleEffect, VehiclePrincipal } from "./vehicle-contract.js";
import { defineVehicleEvent, defineVehicleSchema } from "./vehicle-contract.js";

/** Set once at registry-configuration time (VehicleRegistry.configureApprovals()); never on a per-invoke basis. */
export const DEFAULT_APPROVAL_EFFECTS: readonly VehicleEffect[] = ["destructive", "open-world"];

/** How long a request stays resolvable before it lapses and must be re-requested. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Emitted (as a Vehicle Event) the moment a gated-effect invoke() has no valid capability -- durable-first, before any interactive prompt is attempted. */
export interface VehicleApprovalRequest {
	readonly requestId: string;
	readonly operationName: string;
	readonly operationVersion: number;
	readonly effect: VehicleEffect;
	readonly principal?: VehiclePrincipal;
	readonly requestedAt: number;
	readonly expiresAt: number;
	/** sha256 hex of the exact input the gated invoke() attempted -- a minted capability is scoped to this input, not just the operation. */
	readonly inputHash: string;
}

export type VehicleApprovalDecision = "granted" | "denied";

/** Emitted once vehicle.approval.resolve settles a request, whichever way. */
export interface VehicleApprovalOutcome {
	readonly requestId: string;
	readonly decision: VehicleApprovalDecision;
	readonly decidedAt: number;
	readonly decidedBy?: string;
}

/**
 * The real authority behind an approvalCapability -- replaces today's
 * "any non-empty string satisfies it" rubber stamp. mint() is called only
 * from inside vehicle.approval.resolve once a decision is actually made;
 * verify() is called from invoke() itself against whatever capability the
 * caller presents. A capability is scoped to the exact operation+input it
 * was minted for and expires with its originating request -- presenting a
 * capability minted for a different operation, a different input, or one
 * already consumed (single-use) must fail verify().
 */
export interface VehicleApprovalAuthority {
	mint(request: Pick<VehicleApprovalRequest, "requestId" | "operationName" | "operationVersion" | "expiresAt" | "inputHash">): string;
	verify(capability: string, operationName: string, operationVersion: number, inputHash: string): boolean;
}

const requestedPayloadSchema = defineVehicleSchema<VehicleApprovalRequest>({
	jsonSchema: {
		type: "object",
		properties: {
			requestId: { type: "string" },
			operationName: { type: "string" },
			operationVersion: { type: "number" },
			effect: { type: "string" },
			requestedAt: { type: "number" },
			expiresAt: { type: "number" },
			inputHash: { type: "string" },
		},
		required: ["requestId", "operationName", "operationVersion", "effect", "requestedAt", "expiresAt", "inputHash"],
		additionalProperties: true,
	},
	safeParse(value) {
		if (typeof value !== "object" || value === null) return { success: false, issues: [{ path: [], message: "input must be an object" }] };
		const row = value as Record<string, unknown>;
		if (
			typeof row.requestId !== "string" ||
			typeof row.operationName !== "string" ||
			typeof row.operationVersion !== "number" ||
			typeof row.effect !== "string" ||
			typeof row.requestedAt !== "number" ||
			typeof row.expiresAt !== "number" ||
			typeof row.inputHash !== "string"
		) {
			return { success: false, issues: [{ path: [], message: "invalid approval request payload" }] };
		}
		return { success: true, value: row as unknown as VehicleApprovalRequest };
	},
});

const resolvedPayloadSchema = defineVehicleSchema<VehicleApprovalOutcome>({
	jsonSchema: {
		type: "object",
		properties: {
			requestId: { type: "string" },
			decision: { type: "string", enum: ["granted", "denied"] },
			decidedAt: { type: "number" },
			decidedBy: { type: "string" },
		},
		required: ["requestId", "decision", "decidedAt"],
		additionalProperties: true,
	},
	safeParse(value) {
		if (typeof value !== "object" || value === null) return { success: false, issues: [{ path: [], message: "input must be an object" }] };
		const row = value as Record<string, unknown>;
		if (
			typeof row.requestId !== "string" ||
			(row.decision !== "granted" && row.decision !== "denied") ||
			typeof row.decidedAt !== "number"
		) {
			return { success: false, issues: [{ path: [], message: "invalid approval outcome payload" }] };
		}
		return { success: true, value: row as unknown as VehicleApprovalOutcome };
	},
});

/** Built into every VehicleRegistry once configureApprovals() is called -- never registered unconditionally, so a Vehicle that never opts in has zero manifest/shape change. */
export const vehicleApprovalRequestedEvent = defineVehicleEvent<VehicleApprovalRequest>({
	name: "vehicle.approval.requested",
	version: 1,
	description: "A gated-effect operation was invoked without a valid approval capability.",
	payload: requestedPayloadSchema,
	maxPayloadBytes: 16_384,
});

export const vehicleApprovalResolvedEvent = defineVehicleEvent<VehicleApprovalOutcome>({
	name: "vehicle.approval.resolved",
	version: 1,
	description: "A pending approval request was granted or denied.",
	payload: resolvedPayloadSchema,
	maxPayloadBytes: 4_096,
});
