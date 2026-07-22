import { describe, expect, it } from "bun:test";
import {
	generateSessionSecret,
	hashSessionSecret,
	isSessionRegistered,
	registerSessionIdentity,
	releaseSessionIdentity,
	secretMatches,
	verifySessionSecret,
	type SessionIdentityRecord,
	type SessionIdentityStore,
} from "../src/session-identity.ts";

class InMemorySessionIdentityStore implements SessionIdentityStore {
	private rows = new Map<string, SessionIdentityRecord>();
	find(sessionId: string): SessionIdentityRecord | undefined { return this.rows.get(sessionId); }
	upsert(record: SessionIdentityRecord): void { this.rows.set(record.sessionId, record); }
	remove(sessionId: string): void { this.rows.delete(sessionId); }
	touch(sessionId: string, lastSeenAt: string): void {
		const existing = this.rows.get(sessionId);
		if (existing) this.rows.set(sessionId, { ...existing, lastSeenAt });
	}
	count(): number { return this.rows.size; }
}

describe("generateSessionSecret / hashSessionSecret / secretMatches", () => {
	it("generates distinct 256-bit hex secrets, never the same value twice", () => {
		const a = generateSessionSecret();
		const b = generateSessionSecret();
		expect(a).toMatch(/^[a-f0-9]{64}$/);
		expect(b).toMatch(/^[a-f0-9]{64}$/);
		expect(a).not.toBe(b);
	});

	it("secretMatches is true only for the exact secret that produced the hash", () => {
		const secret = generateSessionSecret();
		const hash = hashSessionSecret(secret);
		expect(secretMatches(secret, hash)).toBe(true);
		expect(secretMatches(generateSessionSecret(), hash)).toBe(false);
	});

	it("secretMatches never throws on a malformed/mismatched-length hash, just returns false", () => {
		expect(secretMatches("anything", "not-hex-at-all")).toBe(false);
		expect(secretMatches("anything", "")).toBe(false);
	});
});

describe("registerSessionIdentity / verifySessionSecret / isSessionRegistered", () => {
	it("an unregistered session id is not registered and verifies as false, never throwing", () => {
		const store = new InMemorySessionIdentityStore();
		expect(isSessionRegistered(store, "session-a")).toBe(false);
		expect(verifySessionSecret(store, "session-a", "guess")).toBe(false);
		expect(verifySessionSecret(store, "session-a", undefined)).toBe(false);
	});

	it("registering returns a secret that verifies true for that exact session id, and false for a different one", () => {
		const store = new InMemorySessionIdentityStore();
		const a = registerSessionIdentity(store, "session-a");
		const b = registerSessionIdentity(store, "session-b");
		expect(a.secret).not.toBe(b.secret);

		expect(verifySessionSecret(store, "session-a", a.secret)).toBe(true);
		expect(verifySessionSecret(store, "session-b", b.secret)).toBe(true);
		// two different explicit session ids must never cross-verify against each other's secret
		expect(verifySessionSecret(store, "session-a", b.secret)).toBe(false);
		expect(verifySessionSecret(store, "session-b", a.secret)).toBe(false);
	});

	it("re-registering the same session id rotates the secret, invalidating the old one", () => {
		const store = new InMemorySessionIdentityStore();
		const first = registerSessionIdentity(store, "session-a");
		expect(verifySessionSecret(store, "session-a", first.secret)).toBe(true);

		const second = registerSessionIdentity(store, "session-a");
		expect(second.secret).not.toBe(first.secret);
		expect(verifySessionSecret(store, "session-a", first.secret)).toBe(false);
		expect(verifySessionSecret(store, "session-a", second.secret)).toBe(true);
	});

	it("touches lastSeenAt on a successful verify", () => {
		const store = new InMemorySessionIdentityStore();
		const { sessionId, secret } = registerSessionIdentity(store, "session-a", () => "2024-01-01T00:00:00.000Z");
		expect(store.find(sessionId)!.lastSeenAt).toBe("2024-01-01T00:00:00.000Z");
		verifySessionSecret(store, sessionId, secret, () => "2024-01-02T00:00:00.000Z");
		expect(store.find(sessionId)!.lastSeenAt).toBe("2024-01-02T00:00:00.000Z");
	});

	it("does not touch lastSeenAt on a failed verify", () => {
		const store = new InMemorySessionIdentityStore();
		const { sessionId } = registerSessionIdentity(store, "session-a", () => "2024-01-01T00:00:00.000Z");
		verifySessionSecret(store, sessionId, "wrong-secret", () => "2024-01-02T00:00:00.000Z");
		expect(store.find(sessionId)!.lastSeenAt).toBe("2024-01-01T00:00:00.000Z");
	});
});

describe("releaseSessionIdentity", () => {
	it("removes the record when the correct secret is presented", () => {
		const store = new InMemorySessionIdentityStore();
		const { sessionId, secret } = registerSessionIdentity(store, "session-a");
		releaseSessionIdentity(store, sessionId, secret);
		expect(isSessionRegistered(store, sessionId)).toBe(false);
	});

	it("is idempotent and side-effect-free for a wrong secret, a missing secret, or an already-absent session id", () => {
		const store = new InMemorySessionIdentityStore();
		const { sessionId, secret } = registerSessionIdentity(store, "session-a");

		releaseSessionIdentity(store, sessionId, "wrong-secret");
		expect(isSessionRegistered(store, sessionId)).toBe(true);

		releaseSessionIdentity(store, sessionId, undefined);
		expect(isSessionRegistered(store, sessionId)).toBe(true);

		releaseSessionIdentity(store, "never-registered", undefined);
		expect(isSessionRegistered(store, "never-registered")).toBe(false);

		// finally release for real, then confirm releasing again is a no-op, not an error
		releaseSessionIdentity(store, sessionId, secret);
		expect(() => releaseSessionIdentity(store, sessionId, secret)).not.toThrow();
		expect(isSessionRegistered(store, sessionId)).toBe(false);
	});
});
