/**
 * Backend-agnostic port for the [secrets] side of the services/secrets model:
 * a named credential/profile, wherever it actually lives (env var, local
 * vault.ts-backed file store, or a remote vault like Enigma). Enigma is one
 * pluggable implementation of this port, not the assumed target -- a
 * daemon-kit consumer with no Enigma running still gets a working /secrets
 * command against its own env/local tiers.
 *
 * Every field on SecretRecord is redaction-safe by construction: there is no
 * accessToken/refreshToken/extra here at all, so a caller can never
 * accidentally surface real credential material through this port.
 */
export interface SecretRecord {
	name: string;
	/** Which backend implementation holds this record, e.g. "env", "local", "enigma". */
	source: string;
	configured: boolean;
	expiresAt?: string;
	scope?: string;
}

export class SecretsBackendUnsupportedOperationError extends Error {
	constructor(source: string, operation: string) {
		super(`${source}: ${operation} is not supported by this backend`);
		this.name = "SecretsBackendUnsupportedOperationError";
	}
}

export interface SecretsBackend {
	readonly source: string;
	list(): Promise<SecretRecord[]>;
	get(name: string): Promise<SecretRecord | undefined>;
	/** Throws SecretsBackendUnsupportedOperationError for a backend with no rotation mechanism (e.g. a plain env var). */
	rotate(name: string): Promise<void>;
	/** Throws SecretsBackendUnsupportedOperationError for a backend with no delete mechanism. */
	revoke(name: string): Promise<void>;
	/**
	 * The real, unredacted record -- accessToken/refreshToken/extra, whatever
	 * the backend actually holds. Deliberately a real port member (not an
	 * afterthought bolted onto the UI): every backend either supports it
	 * genuinely or throws SecretsBackendUnsupportedOperationError, the same
	 * contract rotate/revoke already use. The caller (secrets-tui.ts's
	 * performReveal) is responsible for only ever invoking this from a real
	 * interactive terminal session, never a scripted/RPC one.
	 */
	reveal(name: string): Promise<Record<string, unknown> | undefined>;
}

/**
 * The [services] side: a consumer daemon (pipes, tickets, enigma itself, ...)
 * and which secret names it may use. Deliberately the same shape as Enigma's
 * own ClientRegistration (minus tokenHash) -- not a new format, just exposed
 * generically so any ServicesRegistry-shaped data source (Enigma's real
 * client-registry.ts, or a future non-Enigma one) can be passed in unchanged.
 */
export interface ServiceRecord {
	name: string;
	backends: string[];
	/** Kernel-verified caller uid (SO_PEERCRED), when the registry binds one. */
	uid?: number;
}

export interface ServicesRegistry {
	list(): Promise<ServiceRecord[]> | ServiceRecord[];
}

/** Which services reference a given secret name -- the reverse of ServiceRecord.backends, absent as a first-class query until now. */
export function findServicesUsingSecret(services: ServiceRecord[], secretName: string): ServiceRecord[] {
	return services.filter((service) => service.backends.includes(secretName));
}
