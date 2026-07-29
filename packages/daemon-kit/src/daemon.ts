/**
 * Composition-root helper for a supervised, loopback-only daemon --
 * Bun-native (Bun.serve) or plain Node (node:http), runtime-detected
 * exactly like storage.ts already does for SQLite (bun:sqlite vs
 * node:sqlite via openRawDatabase). Generalizes the skeleton that was
 * identical (bind port 0, write the handle only after a successful bind,
 * run periodic maintenance timers, clean SIGINT/SIGTERM shutdown) across
 * web-spider-daemon, jittor, and papyrus's daemon.ts -- two of which said
 * so in their own header comments.
 *
 * Mirrors jittor's own startDaemon()/serveMain() split, the most testable
 * of the four originals: startDaemon() does no process-level I/O beyond
 * binding a listener itself and returns a stoppable handle; runDaemonProcess()
 * adds the SIGINT/SIGTERM registration and process.exit for the real binary.
 *
 * startDaemon() is async under both runtimes -- Bun.serve() binds
 * synchronously, but node:http's listen() does not (the OS-assigned port
 * is only known once the 'listening' event fires), and this file has
 * exactly one entry point rather than a second parallel one callers must
 * choose between, so the Bun path pays the (negligible) cost of being
 * wrapped in a resolved Promise too.
 *
 * No consumer imports this module's startDaemon() directly outside this
 * package's own tests today, so this is not a breaking change to any real
 * caller -- confirmed directly, not assumed, before making the signature
 * change.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { LOOPBACK_HOST, acquireDaemonLock, releaseDaemonLock, removeDaemonHandle, writeDaemonHandle } from "./paths.ts";
import type { Logger } from "./logging.ts";
import type { PushChannel } from "./push-channel.ts";

const isBun = typeof Bun !== "undefined";

/**
 * Thrown by startDaemon() when another live process already holds the
 * single-instance lock. This is a normal join, not a failure -- exactly one
 * daemon should ever be bound at a time regardless of how many callers
 * raced to start one, so runDaemonProcess() catches this specifically and
 * exits 0 rather than crashing.
 */
export class DaemonAlreadyRunningError extends Error {
	readonly holderPid: number | null;

	// Not a TypeScript parameter-property constructor (`constructor(public readonly holderPid...)`) --
	// that shorthand isn't erasable syntax, and Node's own native type-stripping (no build step,
	// `node file.ts` directly) rejects it outright rather than just ignoring the type annotation.
	// Spelled out so this class -- and everything that imports it -- stays runnable that way, which
	// this task's whole point (a genuinely Node-compatible daemon.ts) depends on.
	constructor(holderPid: number | null) {
		super(
			holderPid === null
				? "a daemon is already running and holds the single-instance lock"
				: `a daemon is already running (pid ${holderPid}) and holds the single-instance lock`,
		);
		this.name = "DaemonAlreadyRunningError";
		this.holderPid = holderPid;
	}
}

export interface MaintenanceTask {
	name: string;
	intervalMs: number;
	run: () => void | Promise<void>;
}

export interface RunningDaemon {
	host: string;
	port: number;
	/** The idle-shutdown budget actually in effect (0 means disabled) -- exposed so a caller/test can observe the provenance-derived default without waiting it out. */
	idleBudgetMs: number;
	stop(): Promise<void>;
}

/**
 * Read by startDaemon() to pick a default idle-shutdown policy when the
 * caller doesn't set idleBudgetMs explicitly. Set by the two things that
 * actually start a daemon process: spawnDetachedDaemon() (pi-client.ts)
 * sets "auto-spawn" on a lazily-started child; the generated systemd
 * unit/launchd plist/Windows Run command (service.ts) sets "service". A
 * daemon started neither way (plain `bun cli.ts serve` during local
 * development) reports "unknown" and is treated the same as "auto-spawn" --
 * the safer default is to assume nothing should run forever unless a real
 * installed service said so.
 *
 * Both this file and pi-client.ts/service.ts declare this same string
 * independently rather than importing a shared constant -- pi-client.ts is
 * compiled standalone with no imports of its own by design (see its module
 * doc comment), so it cannot depend on this module.
 */
export const LAUNCH_PROVENANCE_ENV_VAR = "DAEMON_KIT_LAUNCH_PROVENANCE";
export type LaunchProvenance = "auto-spawn" | "service" | "unknown";

export function readLaunchProvenance(env: Record<string, string | undefined> = process.env): LaunchProvenance {
	const value = env[LAUNCH_PROVENANCE_ENV_VAR];
	return value === "auto-spawn" || value === "service" ? value : "unknown";
}

/** Applied to an auto-spawned or provenance-unknown daemon when the caller doesn't set idleBudgetMs explicitly -- long enough to survive a normal idle gap between tool calls, short enough not to leak a process from one stray call for days. */
export const DEFAULT_AUTO_SPAWN_IDLE_BUDGET_MS = 30 * 60_000;

/** Pure resolution rule, exported for direct testing without waiting out a real idle window. Explicit always wins; "service" provenance means always-on (0/disabled); anything else gets the bounded auto-spawn default. */
export function resolveIdleBudgetMs(explicit: number | undefined, provenance: LaunchProvenance): number {
	if (explicit !== undefined) return explicit;
	return provenance === "service" ? 0 : DEFAULT_AUTO_SPAWN_IDLE_BUDGET_MS;
}

export interface StartDaemonOptions {
	/** e.g. "Web Spider" -- used only in the bind-failure error message. */
	daemonLabel: string;
	handlePath: string;
	/** Defaults to 0600 (owner-only), correct for a same-user daemon and consumer. Pass 0644 for a daemon meant to be discovered across OS users -- the handle's own content (host/port/pid) is never sensitive. See writeDaemonHandle. */
	handleMode?: number;
	/** Defaults to a `daemon.lock` file beside handlePath. Override only if that would collide with another daemon's own state. */
	lockPath?: string;
	buildApp: () => { fetch(request: Request): Promise<Response> };
	/** Defaults to a no-op logger; maintenance-task failures are otherwise silently lost, which was a real gap in two of the four original daemons. */
	logger?: Logger;
	maintenanceTasks?: MaintenanceTask[];
	/**
	 * Explicit override always wins. When omitted, the default is chosen from
	 * LAUNCH_PROVENANCE_ENV_VAR: "service" gets no idle shutdown (0, always-on);
	 * "auto-spawn" or "unknown" get DEFAULT_AUTO_SPAWN_IDLE_BUDGET_MS.
	 */
	idleBudgetMs?: number;
	idleTickMs?: number;
	onShutdown?: () => void | Promise<void>;
	/** Defaults to process.env. Injectable for tests. */
	env?: Record<string, string | undefined>;
	/** Optional WebSocket push-invalidation channel (see push-channel.ts). Additive to the fetch-based RPC -- requests to `pushPath` are routed to it, everything else still goes to buildApp()'s fetch. */
	pushChannel?: PushChannel;
	/** Defaults to "/push". */
	pushPath?: string;
}

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEFAULT_IDLE_TICK_MS = 30_000;

interface ListeningServer {
	port: number;
	stop(): Promise<void>;
}

type DaemonApp = { fetch(request: Request): Promise<Response> };

function startBunListener(options: StartDaemonOptions, app: DaemonApp, pushPath: string, onRequest: () => void): Promise<ListeningServer> {
	const server = Bun.serve({
		hostname: LOOPBACK_HOST,
		port: 0,
		fetch: (request, bunServer) => {
			onRequest();
			if (options.pushChannel && new URL(request.url).pathname === pushPath) {
				return options.pushChannel.upgrade(request, bunServer) ?? undefined;
			}
			return app.fetch(request);
		},
		// Bun's own types require `websocket` whenever `fetch`'s server parameter
		// carries per-connection data (SubscriberData here) -- a no-op fallback
		// when there is no pushChannel is safe: server.upgrade() is never called
		// in that case, so these handlers are never invoked.
		websocket: options.pushChannel?.websocketHandlers() ?? { message() {} },
	});
	return Promise.resolve({
		port: server.port ?? 0,
		stop: () => server.stop(true),
	});
}

/** Adapts a Node IncomingMessage into a standard Request -- buildApp()'s contract is already Web-standard/portable, so this is the only translation node:http needs. */
function nodeRequestToWebRequest(request: IncomingMessage): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const v of value) headers.append(key, v);
		else headers.append(key, value);
	}
	const method = request.method ?? "GET";
	const hasBody = method !== "GET" && method !== "HEAD";
	const url = `http://${request.headers.host ?? LOOPBACK_HOST}${request.url ?? "/"}`;
	const init: RequestInit & { duplex?: "half" } = { method, headers };
	if (hasBody) {
		init.body = Readable.toWeb(request) as unknown as ReadableStream;
		init.duplex = "half"; // required by Node's fetch implementation whenever a request carries a streamed body
	}
	return new Request(url, init);
}

/** Writes a standard Response back onto a Node ServerResponse. */
async function writeWebResponseToNode(response: Response, res: ServerResponse): Promise<void> {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => res.setHeader(key, value));
	if (!response.body) {
		res.end();
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const readable = Readable.fromWeb(response.body as never);
		readable.pipe(res);
		readable.on("end", resolve);
		readable.on("error", reject);
	});
}

function startNodeListener(app: DaemonApp, onRequest: () => void): Promise<ListeningServer> {
	return new Promise((resolve, reject) => {
		const server = createServer((request, res) => {
			onRequest();
			void (async () => {
				try {
					const response = await app.fetch(nodeRequestToWebRequest(request));
					await writeWebResponseToNode(response, res);
				} catch (error) {
					res.statusCode = 500;
					res.end(error instanceof Error ? error.message : String(error));
				}
			})();
		});
		// Tracked so stop() can force-close lingering keep-alive connections --
		// server.close() alone only stops accepting new ones and waits
		// indefinitely for existing ones to end on their own, unlike Bun's own
		// server.stop(true) force semantics this mirrors.
		const sockets = new Set<Socket>();
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		server.once("error", reject);
		server.listen(0, LOOPBACK_HOST, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				port,
				stop: () =>
					new Promise<void>((resolveStop) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => resolveStop());
					}),
			});
		});
	});
}

export async function startDaemon(options: StartDaemonOptions): Promise<RunningDaemon> {
	const logger = options.logger ?? NOOP_LOGGER;
	const lockPath = options.lockPath ?? join(dirname(options.handlePath), "daemon.lock");

	// Claimed before anything else -- a losing process must not build the app,
	// bind a port, or touch the handle file. See DaemonAlreadyRunningError.
	const lock = acquireDaemonLock(lockPath);
	if (!lock.acquired) throw new DaemonAlreadyRunningError(lock.holderPid);

	if (options.pushChannel && !isBun) {
		releaseDaemonLock(lockPath); // never held the port -- must not leave the lock as if it had
		throw new Error(
			`${options.daemonLabel}: pushChannel requires the Bun runtime (WebSocket upgrade support) -- omit pushChannel to run this daemon under Node, or run it under Bun.`,
		);
	}

	const app = options.buildApp();
	const pushPath = options.pushPath ?? "/push";

	let lastActive = Date.now();
	const onRequest = (): void => {
		lastActive = Date.now();
	};
	const listener = isBun ? await startBunListener(options, app, pushPath, onRequest) : await startNodeListener(app, onRequest);
	if (!listener.port) {
		throw new Error(`${options.daemonLabel} daemon failed to bind a listener`);
	}
	writeDaemonHandle(options.handlePath, { host: LOOPBACK_HOST, port: listener.port, pid: process.pid }, options.handleMode);

	const timers: ReturnType<typeof setInterval>[] = [];
	for (const task of options.maintenanceTasks ?? []) {
		timers.push(
			setInterval(() => {
				// `task.run` may return a Promise; awaiting inside this IIFE (rather than the historical
				// `try { void task.run() } catch`) is load-bearing. A synchronous throw is caught either
				// way, but a *rejected* Promise from an async run() would otherwise become an unhandled
				// rejection outside this try/catch entirely -- Bun does not swallow that, it crashes the
				// process (verified directly against a consuming daemon's own now-redundant guard against
				// exactly this: jittor's reportMaintenanceFailure existed only because `void somePromise()`
				// with no `.catch` was fatal). A daemon-kit consumer must get that protection for free.
				void (async () => {
					try {
						await task.run();
					} catch (error) {
						logger.error(`maintenance task failed: ${task.name}`, { error: error instanceof Error ? error.message : String(error) });
					}
				})();
			}, task.intervalMs),
		);
	}

	const provenance = readLaunchProvenance(options.env ?? process.env);
	const effectiveIdleBudgetMs = resolveIdleBudgetMs(options.idleBudgetMs, provenance);

	let idleTimer: ReturnType<typeof setInterval> | undefined;
	if (effectiveIdleBudgetMs > 0) {
		const budget = effectiveIdleBudgetMs;
		idleTimer = setInterval(() => {
			if (Date.now() - lastActive > budget) {
				logger.info("idle budget exceeded, shutting down", { idleBudgetMs: budget });
				void stop();
			}
		}, options.idleTickMs ?? DEFAULT_IDLE_TICK_MS);
	}

	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		for (const timer of timers) clearInterval(timer);
		if (idleTimer) clearInterval(idleTimer);
		removeDaemonHandle(options.handlePath);
		releaseDaemonLock(lockPath);
		await options.onShutdown?.();
		await listener.stop();
	};

	return { host: LOOPBACK_HOST, port: listener.port, idleBudgetMs: effectiveIdleBudgetMs, stop };
}

export interface RunDaemonProcessOptions extends StartDaemonOptions {
	onListen?: (info: { host: string; port: number }) => void;
}

/**
 * The real binary's entry point: starts the daemon, wires SIGINT/SIGTERM to
 * a clean stop + exit. A DaemonAlreadyRunningError (another live process
 * already holds the single-instance lock) is a normal join, not a crash --
 * this process exits 0 without ever having bound a port.
 */
export function runDaemonProcess(options: RunDaemonProcessOptions): void {
	const logger = options.logger ?? NOOP_LOGGER;
	void runDaemonProcessAsync(options, logger);
}

async function runDaemonProcessAsync(options: RunDaemonProcessOptions, logger: Logger): Promise<void> {
	let daemon: RunningDaemon;
	try {
		daemon = await startDaemon(options);
	} catch (error) {
		if (error instanceof DaemonAlreadyRunningError) {
			logger.info(error.message);
			process.exit(0);
		}
		// Rethrown deliberately, not swallowed -- an unhandled rejection crashes
		// the process by default under both Bun and Node, the same loud failure
		// a synchronous throw from the pre-async version of this function gave.
		throw error;
	}
	options.onListen?.({ host: daemon.host, port: daemon.port });
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		void daemon.stop().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
