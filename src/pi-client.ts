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
 * module and the Vehicle SDK are the runtime-neutral precompiled surfaces.
 * This module has no imports of its own -- fetch/Request/TypeError/AbortError
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

export interface CircuitBreakerState {
	/** True when call() is currently short-circuiting instead of attempting a real connect. */
	open: boolean;
	consecutiveFailures: number;
	/** Epoch ms the breaker last opened, or null if it has never opened (or was reset). */
	openedAt: number | null;
}

export interface RetryingClient<Client> {
	/**
	 * Runs `operation` against a connected client. On a stale-connection
	 * error, drops the cached client and retries `operation` exactly once
	 * against a freshly reconnected one; any other error, or a second
	 * consecutive failure, propagates immediately.
	 *
	 * When the circuit breaker is open (see CircuitBreakerOptions), call()
	 * rejects immediately with the last connect failure instead of attempting
	 * a new connect -- a daemon that is fundamentally broken (crash-loops,
	 * corrupt state, missing runtime dependency) would otherwise cost every
	 * single call() the full connect timeout before failing, repeatedly, for
	 * the rest of the session.
	 */
	call<T>(operation: (client: Client) => Promise<T>): Promise<T>;
	/** Drops any cached client and resets the circuit breaker, forcing the next call() to reconnect. */
	reset(): void;
	/** Current breaker state, readable without triggering a live connect attempt. */
	breakerState(): CircuitBreakerState;
}

export interface CreateRetryingClientOptions {
	/** Defaults to isLikelyStaleConnectionError. */
	isStaleConnectionError?: StaleConnectionPredicate;
	/** Used only in the retry-exhausted error message, e.g. "Lector". */
	label?: string;
	/**
	 * Fail-fast policy against a connect() that keeps failing. Pass `false` to
	 * disable entirely (unthrottled retry on every call(), the pre-existing
	 * behavior). Defaults to enabled with failureThreshold: 3, cooldownMs: 10_000.
	 */
	circuitBreaker?: CircuitBreakerOptions | false;
}

export interface CircuitBreakerOptions {
	/** Consecutive connect() failures before call() starts short-circuiting. Defaults to 3. */
	failureThreshold?: number;
	/** How long the breaker stays open before allowing one probe attempt through. Defaults to 10_000ms. */
	cooldownMs?: number;
}

class CircuitBreaker {
	private consecutiveFailures = 0;
	private openedAt: number | null = null;
	private lastError: unknown;

	constructor(
		private readonly failureThreshold: number,
		private readonly cooldownMs: number,
	) {}

	/** False once cooldownMs has elapsed since opening -- that lets exactly one probe attempt through (half-open). */
	isOpen(): boolean {
		if (this.openedAt === null) return false;
		return Date.now() - this.openedAt < this.cooldownMs;
	}

	recordFailure(error: unknown): void {
		this.consecutiveFailures++;
		this.lastError = error;
		if (this.consecutiveFailures >= this.failureThreshold) this.openedAt = Date.now();
	}

	recordSuccess(): void {
		this.consecutiveFailures = 0;
		this.openedAt = null;
		this.lastError = undefined;
	}

	reset(): void {
		this.recordSuccess();
	}

	lastFailure(): unknown {
		return this.lastError;
	}

	state(): CircuitBreakerState {
		return { open: this.isOpen(), consecutiveFailures: this.consecutiveFailures, openedAt: this.openedAt };
	}
}

const NULL_BREAKER: Pick<CircuitBreaker, "isOpen" | "recordFailure" | "recordSuccess" | "reset" | "lastFailure" | "state"> = {
	isOpen: () => false,
	recordFailure: () => {},
	recordSuccess: () => {},
	reset: () => {},
	lastFailure: () => undefined,
	state: () => ({ open: false, consecutiveFailures: 0, openedAt: null }),
};

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
	const breaker =
		options.circuitBreaker === false
			? NULL_BREAKER
			: new CircuitBreaker(options.circuitBreaker?.failureThreshold ?? 3, options.circuitBreaker?.cooldownMs ?? 10_000);
	let cached: Promise<Client> | undefined;

	function resolveClient(): Promise<Client> {
		if (!cached) {
			cached = connect()
				.then((client) => {
					breaker.recordSuccess();
					return client;
				})
				.catch((error: unknown) => {
					cached = undefined;
					breaker.recordFailure(error);
					throw error;
				});
		}
		return cached;
	}

	return {
		async call(operation) {
			if (breaker.isOpen()) throw breaker.lastFailure();
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
			breaker.reset();
		},
		breakerState() {
			return breaker.state();
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
 * However many callers race to spawn() concurrently with no handle present
 * (N Pi sessions, or a human running `serve` twice by hand), only one
 * resulting daemon process ever binds a port and writes a handle -- that is
 * guaranteed daemon-side by startDaemon()'s single-instance lock (see
 * daemon.ts), not here. connectWithPolicy() itself needs no coordination:
 * every caller's poll-for-handle loop converges on whichever single daemon
 * actually won.
 *
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

export interface VersionCheckOptions<Handle extends DaemonHandleLike, Client> {
	/** This extension's own expected daemon version/protocol identifier. */
	expectedVersion: string;
	/** Reads the connected daemon's reported version (e.g. via its /health response). Errors propagate unchanged -- an inconclusive read never triggers a kill. */
	readVersion: (client: Client) => Promise<string>;
	/** Best-effort graceful shutdown request against the stale daemon. Its failure is swallowed -- killStaleProcess is the real fallback that must always work. */
	requestShutdown?: (client: Client) => Promise<void>;
	/** Hard fallback: signal the stale daemon's process directly (e.g. `process.kill(handle.pid, "SIGTERM")`). Must not throw for an already-dead pid. */
	killStaleProcess: (handle: Handle) => void;
	/** Bounded wait for the stale daemon's handle file to clear after shutdown/kill, before spawning its replacement. Defaults to 2000ms. */
	shutdownTimeoutMs?: number;
	/** Poll interval while waiting for the handle file to clear. Defaults to 50ms. */
	shutdownPollIntervalMs?: number;
}

/**
 * Wraps connectWithPolicy with a one-time version handshake: an
 * auto-spawned daemon can outlive the extension package that spawned it --
 * `pi update` upgrades the npm package on disk, but a daemon process
 * started yesterday keeps running with yesterday's code until something
 * notices. Left alone, the client silently talks to a stale daemon whose
 * wire protocol or schema may no longer match what this session expects.
 *
 * On every fresh connect (a new client instance, not a cached call), the
 * daemon's reported version is checked against `expectedVersion`. A
 * mismatch replaces the stale daemon (graceful shutdown request, falling
 * back to a direct kill signal) and reconnects against a freshly spawned
 * one, transparently to the caller -- no error surfaces for a normal
 * version-drift recovery. A version match takes the exact same path as
 * plain connectWithPolicy, with one extra readVersion() call and no other
 * added latency.
 */
export async function connectWithVersionCheck<Handle extends DaemonHandleLike, Client>(
	policy: ConnectPolicyOptions<Handle, Client>,
	versionCheck: VersionCheckOptions<Handle, Client>,
): Promise<Client> {
	const client = await connectWithPolicy(policy);
	const runningVersion = await versionCheck.readVersion(client);
	if (runningVersion === versionCheck.expectedVersion) return client;

	// Without a spawn() a replacement can never come back -- killing the
	// stale daemon here would leave the caller with nothing at all, strictly
	// worse than a detected-but-unreplaced version mismatch. Surface that
	// plainly instead of silently leaving either a dead or a stale daemon.
	if (!policy.spawn) {
		throw new Error(
			`stale daemon detected (running ${runningVersion}, expected ${versionCheck.expectedVersion}) but no spawn() is configured to replace it -- restart the daemon manually`,
		);
	}

	const staleHandle = policy.readHandle();
	if (versionCheck.requestShutdown) {
		try {
			await versionCheck.requestShutdown(client);
		} catch {
			// Best-effort only -- killStaleProcess below is the real guarantee.
		}
	}
	if (staleHandle) versionCheck.killStaleProcess(staleHandle);

	const deadline = Date.now() + (versionCheck.shutdownTimeoutMs ?? 2_000);
	const pollIntervalMs = versionCheck.shutdownPollIntervalMs ?? 50;
	while (Date.now() < deadline && policy.readHandle()) {
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	return connectWithPolicy({ ...policy, autoStart: true });
}

export interface SpawnDetachedDaemonOptions {
	/** Path to the daemon's entry point, e.g. a `#!/usr/bin/env bun` cli.ts. */
	binPath: string;
	args?: string[];
	env?: Record<string, string | undefined>;
	/** Defaults to process.platform. Exposed for tests -- never meant to be overridden in production. */
	platform?: NodeJS.Platform;
	/**
	 * The actual spawn function, injected so this module never hard-imports
	 * node:child_process (this file has no imports of its own -- see the
	 * module doc comment -- keeping it that way matters for Pi's jiti loader).
	 * Each consumer already has a working spawn call; this only supplies the
	 * platform-correct *options* for it.
	 */
	spawn: (command: string, args: string[], options: SpawnPlatformOptions) => void;
}

export interface SpawnPlatformOptions {
	detached: boolean;
	stdio: "ignore";
	env?: Record<string, string | undefined>;
	/** Only meaningful (and only set) on win32 -- suppresses the console window a detached spawn would otherwise pop open. */
	windowsHide?: boolean;
}

/**
 * Centralizes the platform-correct options for auto-spawning a detached
 * daemon process, so each of connectWithPolicy's four independent `spawn()`
 * callbacks doesn't have to get this right on its own. Two Windows-specific
 * gaps this closes:
 *
 * - `windowsHide: true` is required on win32 or a silent background
 *   auto-spawn pops a visible console window.
 * - SIGTERM is not a real signal on Windows: `child.kill("SIGTERM")` there
 *   terminates the process immediately rather than invoking a graceful
 *   shutdown handler, so a killed daemon's own cleanup (handle/lock removal)
 *   never runs. This function does not attempt to work around that --
 *   there is nothing a spawn-time option can do about a signal Windows
 *   doesn't implement. The single-instance lock's stale-pid recovery (see
 *   startDaemon) is the actual recovery path there, not graceful shutdown;
 *   this is stated here so no caller adds a Windows SIGTERM handler
 *   expecting it to reliably fire.
 *
 * The caller still owns `.unref()` on whatever handle its injected `spawn`
 * returns -- this function only shapes the options object, since detaching
 * the returned child handle is inherently spawn-implementation-specific
 * (node:child_process vs Bun.spawn expose that differently).
 */
export function spawnDetachedDaemon(options: SpawnDetachedDaemonOptions): void {
	const platform = options.platform ?? process.platform;
	const spawnOptions: SpawnPlatformOptions = {
		detached: true,
		stdio: "ignore",
		env: options.env,
		...(platform === "win32" ? { windowsHide: true } : {}),
	};
	options.spawn(options.binPath, options.args ?? [], spawnOptions);
}

export type DaemonStatusState = "running" | "not-running" | "stale-handle" | "unreachable";

export interface DaemonStatus {
	state: DaemonStatusState;
	pid?: number;
	version?: string;
	uptimeMs?: number;
	breaker?: CircuitBreakerState;
	/** Set only for state "unreachable" -- the error the connect/version-read attempt raised. */
	lastError?: string;
	/** One human-readable line, safe to print as-is; every other field is the machine-readable detail behind it. */
	summary: string;
}

export interface DaemonStatusOptions<Handle extends DaemonHandleLike, Client> {
	readHandle: () => Handle | null;
	buildClient: (handle: Handle) => Client | Promise<Client>;
	/** Optional -- e.g. reads the daemon's /health response. Omit to report liveness without a version. */
	readVersion?: (client: Client) => Promise<string>;
	/** Optional -- computes uptime from whatever the handle/caller already tracks (daemon-kit does not itself define where a start timestamp lives). */
	startedAtMs?: (handle: Handle) => number | undefined;
	/** Reports a createRetryingClient's breakerState() inline, so "why is nothing happening" and "is the breaker open" are answered by one call. */
	breaker?: () => CircuitBreakerState;
	/** Defaults to process.kill(pid, 0)/EPERM-is-alive semantics. Injectable for tests. */
	isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but we lack permission to signal it --
		// still alive. Any other error (ESRCH, or an invalid pid) means it is not.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Answers "is a daemon running, which version, since when, is it healthy"
 * without the user (or the extension debugging on their behalf) needing to
 * read the handle file or run `ps` by hand -- the one diagnostic surface
 * every consumer's CLI can expose as `<name> status` for parity with the
 * rest of this house's daemon-backed CLIs.
 */
export async function daemonStatus<Handle extends DaemonHandleLike, Client>(options: DaemonStatusOptions<Handle, Client>): Promise<DaemonStatus> {
	const breaker = options.breaker?.();
	const handle = options.readHandle();
	if (!handle) return { state: "not-running", breaker, summary: "not running" };

	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	if (!isPidAlive(handle.pid)) {
		return { state: "stale-handle", pid: handle.pid, breaker, summary: `stale handle file -- pid ${handle.pid} is not running` };
	}

	const uptimeMs = options.startedAtMs ? Date.now() - (options.startedAtMs(handle) ?? Date.now()) : undefined;
	try {
		const client = await options.buildClient(handle);
		const version = options.readVersion ? await options.readVersion(client) : undefined;
		const versionSuffix = version ? `, v${version}` : "";
		return { state: "running", pid: handle.pid, version, uptimeMs, breaker, summary: `running (pid ${handle.pid}${versionSuffix})` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { state: "unreachable", pid: handle.pid, uptimeMs, breaker, lastError: message, summary: `process is alive (pid ${handle.pid}) but not responding: ${message}` };
	}
}
