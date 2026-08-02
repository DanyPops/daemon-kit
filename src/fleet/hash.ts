import { createHash } from "node:crypto";
import { createManifestHash, createPlanHash, type ManifestHash, type PlanHash } from "./identity.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalValue(value[key])]),
	);
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

export function manifestHash(value: unknown): ManifestHash {
	const outcome = createManifestHash(sha256(value));
	if (!outcome.ok) throw new Error(outcome.reason);
	return outcome.value;
}

export function planHash(value: unknown): PlanHash {
	const outcome = createPlanHash(sha256(value));
	if (!outcome.ok) throw new Error(outcome.reason);
	return outcome.value;
}
