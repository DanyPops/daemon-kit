/**
 * Generalizes the retry-once-on-stale-connection wrapper independently
 * reimplemented in lector's `lectorClient()`, web-spider's `callWebSpider()`,
 * papyrus's `callService()`, and pi-packed's `createNatives()` -- one Pi
 * extension-facing seam every consumer daemon needed and none of them
 * shared. A daemon binds a new random port on every restart; a client
 * resolved once and cached for a whole Pi session would otherwise keep
 * calling a dead port until the extension reloaded. `createRetryingClient`
 * detects that on the failing call itself, drops the cached client, and
 * retries exactly once against a freshly reconnected one.
 *
 * Shipped pre-compiled (see the package's `build:pi-client` script and its
 * `./pi-client` export) rather than raw TypeScript like the rest of this
 * package -- this is the one module here meant to be imported directly by a
 * Pi extension rather than by another Bun daemon, and Pi's jiti-based
 * extension loader has a real, demonstrated failure class importing a
 * dependency's raw, unbuilt TypeScript (see pi-load-harness.ts). This
 * module has no imports of its own -- fetch/Request/TypeError/AbortError
 * are all global -- so it is safe to load under Node without a Bun runtime.
 *
 * `connectWithPolicy` covers the other silent per-daemon fork found
 * alongside the retry duplication: whether a missing daemon should be
 * auto-started or fail closed. Both are legitimate policies (web-spider
 * auto-spawns; lector/papyrus/pi-packed fail closed) but were each
 * hardcoded per daemon instead of being a parameter of one shared helper.
 */

export type StaleConnectionPredicate = (error: unknown) => boolean;

/**
 * True when `error` means the connection itself is bad (worth dropping the
 * cached client and retrying once against a fresh one) -- a dead port after
 * a daemon restart, a refused/reset socket, a DNS failure, a timed-out
 * request. False for a genuine domain-level rejection (e.g. a validation
 * error the daemon itself returned), which a retry cannot fix and would
 * only mask. Matches the heuristic already proven identical across every
 * consumer this module replaces.
 */
export function isLikelyStaleConnectionError(error: unknown): boolean {
	if (error instanceof TypeError) return true; // fetch()'s own connection-refused/DNS-failure shape
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	return /fetch failed|unable to connect|network|socket|ECONNRESET|ECONNREFUSED|connection refused/i.test(error.message);
}

export interface RetryingClient<Client> {
	/**
	 * Runs `operation` against a connected client. On a stale-connection
	 * error, drops the cached client and retries `operation` exactly once
	 * against a freshly reconnected one; any other error, or a second
	 * consecutive failure, propagates immediately.
	 */
	call<T>(operation: (client: Client) => Promise<T>): Promise<T>;
	/** Drops any cached client, forcing the next call() to reconnect. */
	reset(): void;
}

export interface CreateRetryingClientOptions {
	/** Defaults to isLikelyStaleConnectionError. */
	isStaleConnectionError?: StaleConnectionPredicate;
	/** Used only in the retry-exhausted error message, e.g. "Lector". */
	label?: string;
}

/**
 * Wraps `connect` (typically a function that reads a daemon's handle file,
 * loads its auth token, and constructs an RPC client) with the caching and
 * retry policy every one of this house's Pi extensions already needed. A
 * failed connection attempt is never cached, so the very next call retries
 * once the daemon is actually reachable.
 */
export function createRetryingClient<Client>(connect: () => Promise<Client>, options: CreateRetryingClientOptions = {}): RetryingClient<Client> {
	const isStale = options.isStaleConnectionError ?? isLikelyStaleConnectionError;
	const label = options.label ?? "daemon";
	let cached: Promise<Client> | undefined;

	function resolveClient(): Promise<Client> {
		if (!cached) {
			cached = connect().catch((error: unknown) => {
				cached = undefined;
				throw error;
			});
		}
		return cached;
	}

	return {
		async call(operation) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const client = await resolveClient();
				try {
					return await operation(client);
				} catch (error) {
					cached = undefined;
					if (attempt === 1 || !isStale(error)) throw error;
				}
			}
			// Unreachable with the current fixed 2-attempt bound -- attempt 1's
			// catch above always either returns or throws. Kept as a labeled
			// safety net rather than a non-null assertion, in case that bound
			// ever becomes configurable.
			throw new Error(`${label} client retry exhausted`);
		},
		reset() {
			cached = undefined;
		},
	};
}

/**
 * The one field every consumer's daemon handle shares: enough to know a
 * daemon is reachable and build a client against it. Consumers pass their
 * own richer handle type through structurally -- this only declares what
 * connectWithPolicy itself needs to read.
 */
export interface DaemonHandleLike {
	host: string;
	port: number;
	pid: number;
}

export interface ConnectPolicyOptions<Handle extends DaemonHandleLike, Client> {
	/** Reads the daemon's current handle file; null when not running or the file is stale/unreadable. */
	readHandle: () => Handle | null;
	/** Builds a connected client from a running daemon's handle (e.g. load the auth token and construct an RPC client). */
	buildClient: (handle: Handle) => Client | Promise<Client>;
	/**
	 * When false (default), no handle means fail closed with `fallbackMessage`
	 * -- the security-conscious default for a loopback-only daemon: nothing
	 * starts a new process on this caller's behalf unless explicitly asked.
	 * When true, `spawn` is called and connectWithPolicy polls for the
	 * handle file to appear.
	 */
	autoStart?: boolean;
	/**
	 * Starts the daemon process; required when autoStart is true. Expected to
	 * return immediately (detached + unref'd is the caller's responsibility)
	 * -- connectWithPolicy does its own polling, it does not await readiness
	 * from this call.
	 */
	spawn?: () => void;
	/** Actionable message used when no daemon is reachable and autoStart is false, or autoStart is true but the daemon never became reachable in time. */
	fallbackMessage: string;
	/** Bounded wait for the handle file to appear after spawn(), in ms. Defaults to 5000. */
	startTimeoutMs?: number;
	/** Poll interval while waiting for the handle file, in ms. Defaults to 100. */
	pollIntervalMs?: number;
}

/**
 * Resolves a connected client from a daemon's handle file, applying one
 * explicit auto-start policy instead of the silent per-daemon fork this
 * house's four Pi extensions each picked independently (web-spider spawns
 * the daemon transparently; lector/papyrus/pi-packed fail closed with an
 * actionable error). `autoStart` defaults to false -- opt in explicitly,
 * consistent with these daemons' loopback-only, nothing-happens-by-default
 * security posture.
 */
export async function connectWithPolicy<Handle extends DaemonHandleLike, Client>(options: ConnectPolicyOptions<Handle, Client>): Promise<Client> {
	const handle = options.readHandle();
	if (handle) return options.buildClient(handle);

	if (!options.autoStart) throw new Error(options.fallbackMessage);
	if (!options.spawn) throw new Error("connectWithPolicy: autoStart is true but no spawn() was provided");
	options.spawn();

	const deadline = Date.now() + (options.startTimeoutMs ?? 5_000);
	const pollIntervalMs = options.pollIntervalMs ?? 100;
	while (Date.now() < deadline) {
		const started = options.readHandle();
		if (started) return options.buildClient(started);
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	throw new Error(options.fallbackMessage);
}
