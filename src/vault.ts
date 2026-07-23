/**
 * Shared OAuth/credential machinery for @danypops daemons that authenticate
 * to an external service (GitHub, GitLab, Jira, Jenkins, ...) on the user's
 * behalf. Three consumers were each independently building a slice of this
 * (pipes' token-provider.ts, pipes' per-backend file stores, tickets'
 * token-store.ts) — this module is the single tested version all of them
 * fold into, plus the client side of talking to a vault daemon (enigma)
 * that holds the encrypted store out of an agent's reach.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ── Token shape + freshness ─────────────────────────────────────────────────

export interface RefreshableAccessToken {
	accessToken: string;
	refreshToken?: string;
	/** ISO timestamp; absent means the provider issued a non-expiring token (e.g. classic GitHub OAuth Apps). */
	expiresAt?: string;
	scope?: string;
	/** Backend-specific extras that don't fit the common shape, e.g. Jira's cloudId. */
	extra?: Record<string, string>;
}

/** A token is usable if it has no expiry, or expires more than `skewMs` from now. */
export function isTokenFresh(token: RefreshableAccessToken, skewMs = 60_000): boolean {
	if (!token.expiresAt) return true;
	return new Date(token.expiresAt).getTime() - Date.now() > skewMs;
}

// ── Per-backend store ────────────────────────────────────────────────────────

export interface TokenProviderStore<T extends RefreshableAccessToken> {
	load(): T | undefined;
	save(token: T): void;
}

function atomicWriteFile(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, contents, { mode: 0o600 });
	renameSync(temp, path);
}

/** Plaintext JSON, one file per backend. Documented as development-only — a real vault daemon must use createEncryptedFileStore. */
export function createFileStore<T extends RefreshableAccessToken>(dir: string, backend: string): TokenProviderStore<T> {
	const path = join(dir, `${backend}.json`);
	return {
		load(): T | undefined {
			if (!existsSync(path)) return undefined;
			try {
				chmodSync(path, 0o600);
				return JSON.parse(readFileSync(path, "utf8")) as T;
			} catch {
				return undefined;
			}
		},
		save(token: T): void {
			atomicWriteFile(path, `${JSON.stringify(token, null, 2)}\n`);
		},
	};
}

const AES_ALGORITHM = "aes-256-gcm";
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;

interface EncryptedEnvelope {
	iv: string;
	authTag: string;
	ciphertext: string;
}

/**
 * AES-256-GCM at rest, one file per backend. GCM's authentication tag makes
 * "wrong master key" and "tampered file" the same failure mode — decryption
 * throws rather than silently returning garbage, so a caller never mistakes
 * a corrupted or mis-keyed file for a valid (if wrong) credential.
 */
export function createEncryptedFileStore<T extends RefreshableAccessToken>(
	options: { dir: string; masterKey: Buffer },
	backend: string,
): TokenProviderStore<T> {
	if (options.masterKey.length !== AES_KEY_BYTES) {
		throw new Error(`vault master key must be ${AES_KEY_BYTES} bytes, got ${options.masterKey.length}`);
	}
	const path = join(options.dir, `${backend}.json`);

	return {
		load(): T | undefined {
			if (!existsSync(path)) return undefined;
			try {
				chmodSync(path, 0o600);
				const envelope = JSON.parse(readFileSync(path, "utf8")) as EncryptedEnvelope;
				const decipher = createDecipheriv(AES_ALGORITHM, options.masterKey, Buffer.from(envelope.iv, "base64"));
				decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
				const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
				return JSON.parse(plaintext.toString("utf8")) as T;
			} catch {
				return undefined;
			}
		},
		save(token: T): void {
			const iv = randomBytes(AES_IV_BYTES);
			const cipher = createCipheriv(AES_ALGORITHM, options.masterKey, iv);
			const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
			const envelope: EncryptedEnvelope = {
				iv: iv.toString("base64"),
				authTag: cipher.getAuthTag().toString("base64"),
				ciphertext: ciphertext.toString("base64"),
			};
			atomicWriteFile(path, `${JSON.stringify(envelope)}\n`);
		},
	};
}

// ── Refresh, with concurrent callers sharing one in-flight refresh ─────────

export interface TokenProviderOptions<T extends RefreshableAccessToken> {
	store: TokenProviderStore<T>;
	/** Omit for backends whose tokens never expire. */
	refresh?: (current: T) => Promise<T>;
	/** Consulted whenever there is no usable stored or refreshed credential. */
	staticFallback?: () => string | undefined;
	refreshSkewMs?: number;
}

/**
 * Builds a `getToken()` an adapter calls before every request instead of
 * holding a static token string. Concurrent callers during a refresh share
 * one in-flight promise rather than each starting their own: several
 * providers issue rotating, single-use refresh tokens, so two independent
 * refresh calls racing on the same stale refresh token would have the loser
 * fail outright. JS's run-to-completion semantics make a plain closure
 * variable sufficient here — everything from reading the store to assigning
 * the in-flight promise happens synchronously, so a second caller can only
 * ever observe the flag after the first caller has set it.
 */
export function createTokenProvider<T extends RefreshableAccessToken>(
	options: TokenProviderOptions<T>,
): () => Promise<string | undefined> {
	let inFlight: Promise<T | undefined> | undefined;

	return async function getToken(): Promise<string | undefined> {
		const stored = options.store.load();
		if (!stored) return options.staticFallback?.();
		if (isTokenFresh(stored, options.refreshSkewMs)) return stored.accessToken;
		if (!options.refresh || !stored.refreshToken) return options.staticFallback?.();

		if (!inFlight) {
			inFlight = (async () => {
				try {
					const current = options.store.load() ?? stored;
					if (isTokenFresh(current, options.refreshSkewMs)) return current;
					if (!current.refreshToken) return undefined;
					const refreshed = await options.refresh?.(current);
					if (!refreshed) return undefined;
					options.store.save(refreshed);
					return refreshed;
				} catch {
					return undefined;
				} finally {
					inFlight = undefined;
				}
			})();
		}

		const refreshedOrNot = await inFlight;
		return refreshedOrNot?.accessToken ?? options.staticFallback?.();
	};
}

// ── Vault client: talks to a vault daemon (e.g. enigma) over authenticated loopback HTTP ─

export interface VaultCredential {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: string;
	scope?: string;
	extra?: Record<string, string>;
}

export interface VaultClient {
	getCredentials(backend: string): Promise<VaultCredential | undefined>;
	rotateCredential(backend: string): Promise<void>;
	revokeCredential(backend: string): Promise<void>;
	listCredentialKeys(): Promise<string[]>;
}

export interface VaultClientOptions {
	/** Loopback base URL, e.g. http://127.0.0.1:<port> — never a remote host, matching daemon-kit's loopback-only invariant. */
	baseUrl: string;
	/** Supervisor's own vault credential, not something an agent process holds. */
	authToken: string;
	fetchImpl?: FetchLike;
}

export function createVaultClient(options: VaultClientOptions): VaultClient {
	const doFetch = options.fetchImpl ?? fetch;
	const base = options.baseUrl.replace(/\/$/, "");

	async function call<T>(method: string, path: string): Promise<T | undefined> {
		const response = await doFetch(`${base}${path}`, {
			method,
			headers: { authorization: `Bearer ${options.authToken}`, accept: "application/json" },
		});
		if (response.status === 404) return undefined;
		if (!response.ok) throw new Error(`vault request failed: ${method} ${path}: HTTP ${response.status}`);
		if (response.status === 204) return undefined;
		const text = await response.text();
		return text ? (JSON.parse(text) as T) : undefined;
	}

	return {
		getCredentials: (backend) => call<VaultCredential>("GET", `/creds/${encodeURIComponent(backend)}`),
		rotateCredential: async (backend) => void (await call("POST", `/rotate/${encodeURIComponent(backend)}`)),
		revokeCredential: async (backend) => void (await call("POST", `/revoke/${encodeURIComponent(backend)}`)),
		listCredentialKeys: async () => (await call<string[]>("GET", "/keys")) ?? [],
	};
}
