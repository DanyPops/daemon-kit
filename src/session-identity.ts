/**
 * Session identity: hardens a coarse, shared-bearer-token daemon boundary (see http.ts's
 * requireBearerToken) against a specific narrower threat -- session-scoped mutable state
 * where a caller-supplied session identifier becomes BEHAVIOR-affecting, not merely a label.
 * Every authenticated caller already looks identical to a daemon-kit daemon (one shared
 * secret); a session identifier alone (e.g. a uuidv7 -- time-ordered, not cryptographically
 * opaque) is not a credential. First-touch capability binding closes the gap without a
 * heavier per-session auth scheme: the first caller to register a given session id receives
 * a random opaque secret; a caller must present the matching secret to act on that SAME
 * session id again. A session id that was never registered is unaffected -- additive/opt-in
 * armor, not a breaking change for every existing caller.
 *
 * Deliberately storage-agnostic: this module owns only the cryptographic primitive (secret
 * generation, hashing, constant-time verification) and the interface a store must satisfy --
 * not any particular SQL schema. Each consuming daemon persists SessionIdentityRecord however
 * its own storage layer already works (see storage.ts for the shared bun:sqlite bootstrap,
 * usable independently of this module -- a consumer with its own incompatible storage
 * runtime, e.g. a dual bun:sqlite/node:sqlite abstraction, still gets the primitive here).
 *
 * Explicitly NOT solved: a race at first contact (whoever registers a session id first
 * becomes its legitimate owner). No primitive available in this deployment shape (one shared
 * bearer token, no peer-credential channel -- checked directly against Bun's public server
 * API, which exposes no SO_PEERCRED-equivalent for either TCP or Unix-socket listeners)
 * closes that; document it explicitly rather than overselling this as verified identity.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface SessionIdentityRecord {
	sessionId: string;
	secretHash: string;
	registeredAt: string;
	lastSeenAt: string;
}

/** Storage port a consuming daemon implements against its own persistence layer. */
export interface SessionIdentityStore {
	find(sessionId: string): SessionIdentityRecord | undefined;
	upsert(record: SessionIdentityRecord): void;
	remove(sessionId: string): void;
	touch(sessionId: string, lastSeenAt: string): void;
	/** Total registered rows, so the caller can enforce its own bound (this module does not cap storage itself). */
	count(): number;
}

export interface RegisterSessionIdentityResult {
	sessionId: string;
	/** Plaintext secret, generated fresh on every call. Shown to the caller exactly once -- only the hash is ever persisted. */
	secret: string;
}

const SESSION_SECRET_BYTES = 32;

export function generateSessionSecret(): string {
	return randomBytes(SESSION_SECRET_BYTES).toString("hex");
}

export function hashSessionSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison so verification timing cannot leak how many hex characters matched. */
export function secretMatches(secret: string, expectedHash: string): boolean {
	const actual = Buffer.from(hashSessionSecret(secret), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}

/**
 * Registers (or re-registers, rotating the secret) a session id and returns its new plaintext
 * secret. Rotation on every call is intentional: a host like Pi can reuse the same session id
 * across a "resume" of a prior process incarnation, so the newest registrant becomes the sole
 * legitimate holder going forward, safely invalidating any stale secret a now-exited process
 * held.
 */
export function registerSessionIdentity(store: SessionIdentityStore, sessionId: string, now: () => string = () => new Date().toISOString()): RegisterSessionIdentityResult {
	const secret = generateSessionSecret();
	const timestamp = now();
	store.upsert({ sessionId, secretHash: hashSessionSecret(secret), registeredAt: timestamp, lastSeenAt: timestamp });
	return { sessionId, secret };
}

export function isSessionRegistered(store: SessionIdentityStore, sessionId: string): boolean {
	return store.find(sessionId) !== undefined;
}

/**
 * Verifies a presented secret against a registered session id, touching lastSeenAt on
 * success. Returns false (never throws) both when the session id was never registered and
 * when the secret is missing or wrong -- a caller that needs to distinguish "no armor
 * configured" (proceed unauthenticated, the opt-in-armor default) from "armor present but
 * secret wrong" (reject) must call isSessionRegistered() first.
 */
export function verifySessionSecret(store: SessionIdentityStore, sessionId: string, secret: string | undefined, now: () => string = () => new Date().toISOString()): boolean {
	const record = store.find(sessionId);
	if (!record) return false;
	if (!secret || !secretMatches(secret, record.secretHash)) return false;
	store.touch(sessionId, now());
	return true;
}

/**
 * Releases a session id's identity, requiring the correct secret. Idempotent: a wrong or
 * missing secret, or an already-absent session id, safely does nothing rather than erroring
 * -- this also avoids an oracle for "does this session id exist" to a caller who doesn't
 * already hold its secret.
 */
export function releaseSessionIdentity(store: SessionIdentityStore, sessionId: string, secret: string | undefined): void {
	const record = store.find(sessionId);
	if (!record) return;
	if (!secret || !secretMatches(secret, record.secretHash)) return;
	store.remove(sessionId);
}
