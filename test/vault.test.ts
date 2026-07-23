import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEncryptedFileStore,
	createFileStore,
	createTokenProvider,
	createVaultClient,
	isTokenFresh,
	type FetchLike,
	type RefreshableAccessToken,
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

function fakeStore(initial: RefreshableAccessToken | undefined) {
	let current = initial;
	return {
		load: () => current,
		save: (token: RefreshableAccessToken) => {
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

describe("createVaultClient", () => {
	it("sends the supervisor bearer token and parses credentials JSON", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("http://127.0.0.1:9999/creds/github");
			expect((init?.headers as Record<string, string>).authorization).toBe("Bearer supervisor-token");
			return new Response(JSON.stringify({ accessToken: "gh-token" }), { status: 200 });
		};
		const client = createVaultClient({ baseUrl: "http://127.0.0.1:9999", authToken: "supervisor-token", fetchImpl });
		expect(await client.getCredentials("github")).toEqual({ accessToken: "gh-token" });
	});

	it("returns undefined, not an error, for a 404 (backend not configured in the vault)", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const client = createVaultClient({ baseUrl: "http://127.0.0.1:9999", authToken: "t", fetchImpl });
		expect(await client.getCredentials("missing")).toBeUndefined();
	});

	it("throws on a non-404 error status rather than returning a falsy credential silently", async () => {
		const fetchImpl: FetchLike = async () => new Response("boom", { status: 500 });
		const client = createVaultClient({ baseUrl: "http://127.0.0.1:9999", authToken: "t", fetchImpl });
		await expect(client.getCredentials("github")).rejects.toThrow(/HTTP 500/);
	});

	it("lists credential keys", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("http://127.0.0.1:9999/keys");
			return new Response(JSON.stringify(["github", "gitlab"]), { status: 200 });
		};
		const client = createVaultClient({ baseUrl: "http://127.0.0.1:9999", authToken: "t", fetchImpl });
		expect(await client.listCredentialKeys()).toEqual(["github", "gitlab"]);
	});

	it("rotate and revoke post to the right path and resolve on 204", async () => {
		const calls: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push(`${init?.method} ${url}`);
			return new Response(null, { status: 204 });
		};
		const client = createVaultClient({ baseUrl: "http://127.0.0.1:9999", authToken: "t", fetchImpl });
		await client.rotateCredential("gitlab");
		await client.revokeCredential("gitlab");
		expect(calls).toEqual(["POST http://127.0.0.1:9999/rotate/gitlab", "POST http://127.0.0.1:9999/revoke/gitlab"]);
	});
});
