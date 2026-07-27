/**
 * Composition-root helper for a supervised, loopback-only Bun daemon.
 * Generalizes the skeleton that was identical (bind port 0, write the
 * handle only after a successful bind, run periodic maintenance timers,
 * clean SIGINT/SIGTERM shutdown) across web-spider-daemon, jittor, and
 * papyrus's daemon.ts -- two of which said so in their own header comments.
 *
 * Mirrors jittor's own startDaemon()/serveMain() split, the most testable
 * of the four originals: startDaemon() does no process-level I/O beyond
 * Bun.serve itself and returns a stoppable handle; runDaemonProcess() adds
 * the SIGINT/SIGTERM registration and process.exit for the real binary.
 */
import { dirname, join } from "node:path";
import { LOOPBACK_HOST, acquireDaemonLock, releaseDaemonLock, removeDaemonHandle, writeDaemonHandle } from "./paths.ts";
import type { Logger } from "./logging.ts";

/**
 * Thrown by startDaemon() when another live process already holds the
 * single-instance lock. This is a normal join, not a failure -- exactly one
 * daemon should ever be bound at a time regardless of how many callers
 * raced to start one, so runDaemonProcess() catches this specifically and
 * exits 0 rather than crashing.
 */
export class DaemonAlreadyRunningError extends Error {
	constructor(public readonly holderPid: number | null) {
		super(
			holderPid === null
				? "a daemon is already running and holds the single-instance lock"
				: `a daemon is already running (pid ${holderPid}) and holds the single-instance lock`,
		);
		this.name = "DaemonAlreadyRunningError";
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
}

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEFAULT_IDLE_TICK_MS = 30_000;

export function startDaemon(options: StartDaemonOptions): RunningDaemon {
	const logger = options.logger ?? NOOP_LOGGER;
	const lockPath = options.lockPath ?? join(dirname(options.handlePath), "daemon.lock");

	// Claimed before anything else -- a losing process must not build the app,
	// bind a port, or touch the handle file. See DaemonAlreadyRunningError.
	const lock = acquireDaemonLock(lockPath);
	if (!lock.acquired) throw new DaemonAlreadyRunningError(lock.holderPid);

	const app = options.buildApp();

	let lastActive = Date.now();
	const server = Bun.serve({
		hostname: LOOPBACK_HOST,
		port: 0,
		fetch: (request) => {
			lastActive = Date.now();
			return app.fetch(request);
		},
	});
	if (!server.port) {
		throw new Error(`${options.daemonLabel} daemon failed to bind a listener`);
	}
	writeDaemonHandle(options.handlePath, { host: LOOPBACK_HOST, port: server.port, pid: process.pid });

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
		await server.stop(true);
	};

	return { host: LOOPBACK_HOST, port: server.port, idleBudgetMs: effectiveIdleBudgetMs, stop };
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
	let daemon: RunningDaemon;
	try {
		daemon = startDaemon(options);
	} catch (error) {
		if (error instanceof DaemonAlreadyRunningError) {
			logger.info(error.message);
			process.exit(0);
		}
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
