/**
 * Env-var SecretsBackend: the Tier-1 credential source most daemon-kit
 * consumers already fall back to (pipes, tickets both resolve a static
 * token from process.env before ever touching a local store or Enigma).
 * Read-only by nature -- an env var isn't something this process can
 * rotate or delete, so both throw SecretsBackendUnsupportedOperationError
 * rather than silently no-op.
 */
import { type SecretRecord, type SecretsBackend, SecretsBackendUnsupportedOperationError } from "./secrets-backend.ts";

const SOURCE = "env";

/** `mapping` is secretName -> the env var that backs it, e.g. { github: "GITHUB_TOKEN" }. */
export function createEnvSecretsBackend(mapping: Record<string, string>, env: NodeJS.ProcessEnv = process.env): SecretsBackend {
	function record(name: string): SecretRecord {
		const envVarName = mapping[name];
		return { name, source: SOURCE, configured: envVarName !== undefined && !!env[envVarName] };
	}

	return {
		source: SOURCE,
		async list() {
			return Object.keys(mapping).map(record);
		},
		async get(name) {
			if (!(name in mapping)) return undefined;
			return record(name);
		},
		async rotate() {
			throw new SecretsBackendUnsupportedOperationError(SOURCE, "rotate");
		},
		async revoke() {
			throw new SecretsBackendUnsupportedOperationError(SOURCE, "revoke");
		},
		async reveal(name) {
			const envVarName = mapping[name];
			if (!envVarName) return undefined;
			const value = env[envVarName];
			return value ? { accessToken: value } : undefined;
		},
	};
}
