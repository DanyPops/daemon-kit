import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEncryptedFileStore,
	createFileStore,
	createTokenProvider,
	isTokenFresh,
	type RefreshableAccessToken,
	type TokenProviderStore,
} from "../src/vault.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "daemon-kit-vault-"));
}

describe("isTokenFresh", () => {
	it("treats a token with no expiresAt as always fresh", () => {
		expect(isTokenFresh({ accessToken: "a" })).toBe(true);
	});

	it("applies the skew ahead of the literal expiry moment", () => {
		const token = { accessToken: "a", expiresAt: new Date(Date.now() + 5_000).toISOString() };
		expect(isTokenFresh(token, 10_000)).toBe(false); // 5s of real validity left, under a 10s skew
		expect(isTokenFresh(token, 1_000)).toBe(true); // 5s left, above a 1s skew
	});
});

describe("createFileStore", () => {
	it("round-trips a token through a plaintext file keyed by backend", () => {
		const dir = tmpDir();
		try {
			const store = createFileStore<RefreshableAccessToken>(dir, "github");
			expect(store.load()).toBeUndefined();
			store.save({ accessToken: "gho_x", scope: "repo" });
			expect(store.load()).toEqual({ accessToken: "gho_x", scope: "repo" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps separate backends in separate files, not colliding", () => {
		const dir = tmpDir();
		try {
			createFileStore<RefreshableAccessToken>(dir, "github").save({ accessToken: "gh-token" });
			createFileStore<RefreshableAccessToken>(dir, "gitlab").save({ accessToken: "gl-token" });
			expect(createFileStore<RefreshableAccessToken>(dir, "github").load()?.accessToken).toBe("gh-token");
			expect(createFileStore<RefreshableAccessToken>(dir, "gitlab").load()?.accessToken).toBe("gl-token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createEncryptedFileStore", () => {
	it("round-trips a token through AES-256-GCM encryption at rest", () => {
		const dir = tmpDir();
		try {
			const masterKey = randomBytes(32);
			const store = createEncryptedFileStore<RefreshableAccessToken>({ dir, masterKey }, "jira");
			store.save({ accessToken: "jira-token", extra: { cloudId: "abc-123" } });
			expect(store.load()).toEqual({ accessToken: "jira-token", extra: { cloudId: "abc-123" } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a master key of the wrong length rather than silently truncating/padding it", () => {
		const dir = tmpDir();
		try {
			expect(() => createEncryptedFileStore({ dir, masterKey: randomBytes(16) }, "jira")).toThrow(/32 bytes/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails to decrypt (returns undefined, not garbage) when read with the wrong master key", () => {
		const dir = tmpDir();
		try {
			const writer = createEncryptedFileStore<RefreshableAccessToken>({ dir, masterKey: randomBytes(32) }, "jira");
			writer.save({ accessToken: "jira-token" });

			const reader = createEncryptedFileStore<RefreshableAccessToken>({ dir, masterKey: randomBytes(32) }, "jira");
			expect(reader.load()).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stores ciphertext on disk, not the plaintext access token", () => {
		const dir = tmpDir();
		try {
			const store = createEncryptedFileStore<RefreshableAccessToken>({ dir, masterKey: randomBytes(32) }, "jira");
			store.save({ accessToken: "super-secret-token-value" });
			const contents = readFileSync(join(dir, "jira.json"), "utf8");
			expect(contents).not.toContain("super-secret-token-value");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Generic (not just typed with the RefreshableAccessToken base interface) so
// createTokenProvider()'s own T inference has one consistent source across a
// call's store and refresh() argument -- an ungeneric version left T's
// inference to guess between two structurally-compatible-but-not-identical
// shapes, which a newer TypeScript version resolved differently than an
// older one, though production code (vault.ts's own logic) was never wrong.
function fakeStore<T extends RefreshableAccessToken>(initial: T | undefined): TokenProviderStore<T> & { readonly current: T | undefined } {
	let current = initial;
	return {
		load: () => current,
		save: (token: T) => {
			current = token;
		},
		get current() {
			return current;
		},
	};
}

describe("createTokenProvider", () => {
	it("returns the stored token directly when fresh", async () => {
		const store = fakeStore({ accessToken: "fresh", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
		const getToken = createTokenProvider({ store });
		expect(await getToken()).toBe("fresh");
	});

	it("falls back to the static token when nothing is stored", async () => {
		const store = fakeStore(undefined);
		const getToken = createTokenProvider({ store, staticFallback: () => "static-pat" });
		expect(await getToken()).toBe("static-pat");
	});

	it("falls back to the static token when expired with no refresh function configured", async () => {
		const store = fakeStore({ accessToken: "stale", expiresAt: new Date(Date.now() - 1_000).toISOString(), refreshToken: "r" });
		const getToken = createTokenProvider({ store, staticFallback: () => "static-pat" });
		expect(await getToken()).toBe("static-pat");
	});

	it("refreshes an expired token and persists the rotated credential back to the store", async () => {
		const store = fakeStore({ accessToken: "stale", expiresAt: new Date(Date.now() - 1_000).toISOString(), refreshToken: "r1" });
		const getToken = createTokenProvider({
			store,
			refresh: async (current) => ({
				accessToken: "rotated",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				refreshToken: `${current.refreshToken}-next`,
			}),
		});
		expect(await getToken()).toBe("rotated");
		expect(store.current?.refreshToken).toBe("r1-next");
	});

	it("shares one in-flight refresh across concurrent callers instead of racing two refresh calls", async () => {
		const store = fakeStore({ accessToken: "stale", expiresAt: new Date(Date.now() - 1_000).toISOString(), refreshToken: "r1" });
		let refreshCalls = 0;
		const getToken = createTokenProvider({
			store,
			refresh: async () => {
				refreshCalls += 1;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { accessToken: "rotated", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "r2" };
			},
		});

		const [a, b, c] = await Promise.all([getToken(), getToken(), getToken()]);
		expect([a, b, c]).toEqual(["rotated", "rotated", "rotated"]);
		expect(refreshCalls).toBe(1);
	});

	it("falls back to the static token when refresh itself fails, rather than throwing", async () => {
		const store = fakeStore({ accessToken: "stale", expiresAt: new Date(Date.now() - 1_000).toISOString(), refreshToken: "r1" });
		const getToken = createTokenProvider({
			store,
			refresh: async () => {
				throw new Error("refresh endpoint unreachable");
			},
			staticFallback: () => "static-pat",
		});
		expect(await getToken()).toBe("static-pat");
	});
});
