/**
 * "Watch a changing resource, get notified" -- lifted near-verbatim from
 * Lector's own `WatchRegistry` (packages/lector/src/domain/watch-registry.ts),
 * generalized past Lector's own workspace/pattern vocabulary (`workspaceId`
 * -> `scope`, `pattern` -> `resource`) into a shared Vehicle primitive.
 * Confirmed independently reinvented three-plus times across this house's
 * own ecosystem before this existed: Lector's own registry, Lector's CLI
 * (a second, non-resilient reimplementation of the same watch/subscribe
 * shape), and Papyrus's TaskOverlay/NoteOverlay (each hand-rolling the same
 * ensurePushChannel()+poll dance independently).
 *
 * Pure, in-memory bookkeeping only -- no filesystem, network, or PushChannel
 * I/O here. Matching pattern/resource against a real changed resource is a
 * provider's own job, not this registry's; this only tracks which topic a
 * given (scope, resource) pair publishes under, and bounds how many watches
 * one scope can accumulate.
 */

/** Matches WatchRegistry's own historical default (Lector's MAX_WATCHES_PER_WORKSPACE). */
export const DEFAULT_MAX_WATCHES_PER_SCOPE = 32;

export interface WatchRegistration {
	readonly watchId: string;
	readonly scope: string;
	readonly resource: string;
	readonly topic: string;
}

/** Raised when a scope already has its configured maximum of registrations -- fails closed, the same bounded-resource discipline every other Vehicle capability already applies, rather than letting one scope accumulate unbounded watch state. */
export class WatchLimitExceeded extends Error {
	constructor(
		readonly scope: string,
		readonly max: number,
	) {
		super(`scope "${scope}" already has ${max} active watches -- unwatch one before adding another`);
		this.name = "WatchLimitExceeded";
	}
}

/**
 * Raised when watchId already identifies a registration, in this scope or any other.
 * add() previously let a duplicate id silently overwrite byId's entry while leaving
 * the id behind in its original scope's byScope Set, corrupting both indexes: the
 * original scope kept counting a watch whose byId lookup now pointed at the wrong
 * scope/resource/topic (or, after remove(), a permanent phantom entry that could
 * never itself be looked up but still consumed that scope's own bound forever).
 * Fails closed instead, before either index is touched.
 */
export class WatchIdConflict extends Error {
	constructor(readonly watchId: string) {
		super(`watchId "${watchId}" is already registered -- watch ids must be unique across every scope`);
		this.name = "WatchIdConflict";
	}
}

export interface WatchRegistryOptions {
	/** Defaults to DEFAULT_MAX_WATCHES_PER_SCOPE. */
	readonly maxWatchesPerScope?: number;
}

export class WatchRegistry {
	private readonly byId = new Map<string, WatchRegistration>();
	private readonly byScope = new Map<string, Set<string>>();
	private readonly maxWatchesPerScope: number;

	constructor(options: WatchRegistryOptions = {}) {
		this.maxWatchesPerScope = options.maxWatchesPerScope ?? DEFAULT_MAX_WATCHES_PER_SCOPE;
	}

	add(scope: string, resource: string, watchId: string, topic: string): WatchRegistration {
		if (this.byId.has(watchId)) throw new WatchIdConflict(watchId);
		const existing = this.byScope.get(scope) ?? new Set();
		if (existing.size >= this.maxWatchesPerScope) throw new WatchLimitExceeded(scope, this.maxWatchesPerScope);
		const registration: WatchRegistration = { watchId, scope, resource, topic };
		existing.add(watchId);
		this.byScope.set(scope, existing);
		this.byId.set(watchId, registration);
		return registration;
	}

	/** The removed registration, or undefined if watchId was already unknown -- idempotent, like the rest of Vehicle's own unregister-shaped operations. Returns the registration itself (not just a boolean) so a caller can tell which scope lost its last watch without a separate lookup. */
	remove(watchId: string): WatchRegistration | undefined {
		const registration = this.byId.get(watchId);
		if (!registration) return undefined;
		this.byId.delete(watchId);
		const scopeWatches = this.byScope.get(registration.scope);
		scopeWatches?.delete(watchId);
		if (scopeWatches?.size === 0) this.byScope.delete(registration.scope);
		return registration;
	}

	/** False once a scope has zero remaining registrations -- a provider's own signal to release whatever underlying watch/subscription resource that scope was backing. */
	hasAnyFor(scope: string): boolean {
		return (this.byScope.get(scope)?.size ?? 0) > 0;
	}

	registrationsFor(scope: string): readonly WatchRegistration[] {
		const ids = this.byScope.get(scope);
		if (!ids) return [];
		return Array.from(ids, (id) => this.byId.get(id)).filter(
			(registration): registration is WatchRegistration => registration !== undefined,
		);
	}
}

/**
 * The wire topic name a watch's changes publish under -- one shared naming
 * function so a provider's publish() call and a subscriber's connectPushChannel()
 * topic can never drift apart, the same role vehicleEventTopic() plays for
 * Vehicle Events' own declared, fixed-schema event types. Deliberately a
 * separate function/namespace from vehicleEventTopic(): a watch's topic is
 * per-watch-instance-dynamic (one new topic per watchId), not a small fixed
 * set of declared event types, so it doesn't fit Vehicle Events' own
 * name@version schema-declaration model -- it reuses the same PushChannel
 * transport substrate Vehicle Events made available generically, not the
 * declared-event-type layer itself.
 */
export function vehicleWatchTopic(watchId: string): string {
	return `vehicle-watch:${watchId}`;
}
