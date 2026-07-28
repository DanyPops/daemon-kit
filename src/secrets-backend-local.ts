/**
 * Local-profile-store SecretsBackend: wraps vault.ts's own createFileStore /
 * createEncryptedFileStore -- the Tier-2 storage every daemon-kit consumer
 * (pipes' repos.json profiles, tickets' oauth store) already keeps one file
 * per backend name in one directory. This backend just enumerates that
 * directory generically instead of each consumer hand-rolling its own
 * list/status/delete pass over the same files.
 *
 * Rotation has no generic mechanism here -- refreshing a real OAuth token
 * needs that provider's own refresh flow, which this port doesn't know
 * about -- so rotate() always throws. Revoke is a plain file delete.
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type SecretRecord, type SecretsBackend, SecretsBackendUnsupportedOperationError } from "./secrets-backend.ts";
import { createEncryptedFileStore, createFileStore, type RefreshableAccessToken, type TokenProviderStore } from "./vault.ts";

const SOURCE = "local";

export interface LocalSecretsBackendOptions {
	dir: string;
	/** When given, every file is read/written through createEncryptedFileStore (AES-256-GCM) instead of plaintext. */
	masterKey?: Buffer;
}

function storeFor(options: LocalSecretsBackendOptions, name: string): TokenProviderStore<RefreshableAccessToken> {
	return options.masterKey ? createEncryptedFileStore({ dir: options.dir, masterKey: options.masterKey }, name) : createFileStore(options.dir, name);
}

function toRecord(name: string, token: RefreshableAccessToken | undefined): SecretRecord {
	if (!token) return { name, source: SOURCE, configured: false };
	return { name, source: SOURCE, configured: true, ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}), ...(token.scope ? { scope: token.scope } : {}) };
}

export function createLocalSecretsBackend(options: LocalSecretsBackendOptions): SecretsBackend {
	return {
		source: SOURCE,
		async list() {
			if (!existsSync(options.dir)) return [];
			const names = readdirSync(options.dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -".json".length));
			return names.map((name) => toRecord(name, storeFor(options, name).load()));
		},
		async get(name) {
			const token = storeFor(options, name).load();
			return token ? toRecord(name, token) : undefined;
		},
		async rotate() {
			throw new SecretsBackendUnsupportedOperationError(SOURCE, "rotate");
		},
		async revoke(name) {
			const path = join(options.dir, `${name}.json`);
			if (!existsSync(path)) return;
			unlinkSync(path);
		},
		async reveal(name) {
			const token = storeFor(options, name).load();
			return token ? (token as unknown as Record<string, unknown>) : undefined;
		},
	};
}
