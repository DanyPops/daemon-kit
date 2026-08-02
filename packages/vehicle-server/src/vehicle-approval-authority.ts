/**
 * The default VehicleApprovalAuthority: an HMAC-signed, single-use,
 * operation+input-scoped capability. Needs node:crypto (HMAC, a timing-safe
 * comparison) so it lives here rather than in vehicle-core, mirroring the
 * fs-adapter split atomic-json.ts already uses.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { VehicleApprovalAuthority, VehicleApprovalRequest } from "@danypops/vehicle-core";

/** Bounds the single-use "already consumed" ledger the same way every other Vehicle capacity is bounded -- a real deployment approving thousands of unexpired requests without ever restarting is not a case worth sizing for. */
const MAX_TRACKED_CONSUMED_CAPABILITIES = 4_096;

export function hashApprovalInput(input: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(input) ?? "undefined";
	} catch {
		serialized = String(input);
	}
	return createHash("sha256").update(serialized).digest("hex");
}

export class HmacApprovalAuthority implements VehicleApprovalAuthority {
	private readonly secret: Buffer;
	private readonly consumed = new Set<string>();

	constructor(secret?: Buffer) {
		this.secret = secret ?? randomBytes(32);
	}

	mint(request: Pick<VehicleApprovalRequest, "requestId" | "operationName" | "operationVersion" | "expiresAt" | "inputHash">): string {
		const signature = this.sign(request.requestId, request.operationName, request.operationVersion, request.expiresAt, request.inputHash);
		return `${request.requestId}.${request.expiresAt}.${signature}`;
	}

	verify(capability: string, operationName: string, operationVersion: number, inputHash: string): boolean {
		const parts = capability.split(".");
		if (parts.length !== 3) return false;
		const [requestId, expiresAtRaw, signature] = parts as [string, string, string];
		const expiresAt = Number(expiresAtRaw);
		if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
		if (this.consumed.has(capability)) return false;

		const expected = this.sign(requestId, operationName, operationVersion, expiresAt, inputHash);
		const expectedBuffer = Buffer.from(expected, "hex");
		const actualBuffer = Buffer.from(signature, "hex");
		if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) return false;

		this.markConsumed(capability);
		return true;
	}

	private sign(requestId: string, operationName: string, operationVersion: number, expiresAt: number, inputHash: string): string {
		const payload = `${requestId}.${operationName}@${operationVersion}.${expiresAt}.${inputHash}`;
		return createHmac("sha256", this.secret).update(payload).digest("hex");
	}

	private markConsumed(capability: string): void {
		if (this.consumed.size >= MAX_TRACKED_CONSUMED_CAPABILITIES) {
			const oldest = this.consumed.values().next().value;
			if (oldest !== undefined) this.consumed.delete(oldest);
		}
		this.consumed.add(capability);
	}
}
