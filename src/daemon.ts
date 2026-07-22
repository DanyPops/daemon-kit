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
import { LOOPBACK_HOST, removeDaemonHandle, writeDaemonHandle } from "./paths.ts";
import type { Logger } from "./logging.ts";

export interface MaintenanceTask {
	name: string;
	intervalMs: number;
	run: () => void | Promise<void>;
}

export interface RunningDaemon {
	host: string;
	port: number;
	stop(): Promise<void>;
}

export interface StartDaemonOptions {
	/** e.g. "Web Spider" -- used only in the bind-failure error message. */
	daemonLabel: string;
	handlePath: string;
	buildApp: () => { fetch(request: Request): Promise<Response> };
	/** Defaults to a no-op logger; maintenance-task failures are otherwise silently lost, which was a real gap in two of the four original daemons. */
	logger?: Logger;
	maintenanceTasks?: MaintenanceTask[];
	/** 0 or undefined disables the idle watchdog -- the default for always-on systemd services. */
	idleBudgetMs?: number;
	idleTickMs?: number;
	onShutdown?: () => void | Promise<void>;
}

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEFAULT_IDLE_TICK_MS = 30_000;

export function startDaemon(options: StartDaemonOptions): RunningDaemon {
	const logger = options.logger ?? NOOP_LOGGER;
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
				try {
					void task.run();
				} catch (error) {
					logger.error(`maintenance task failed: ${task.name}`, { error: error instanceof Error ? error.message : String(error) });
				}
			}, task.intervalMs),
		);
	}

	let idleTimer: ReturnType<typeof setInterval> | undefined;
	if (options.idleBudgetMs && options.idleBudgetMs > 0) {
		const budget = options.idleBudgetMs;
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
		await options.onShutdown?.();
		await server.stop(true);
	};

	return { host: LOOPBACK_HOST, port: server.port, stop };
}

export interface RunDaemonProcessOptions extends StartDaemonOptions {
	onListen?: (info: { host: string; port: number }) => void;
}

/** The real binary's entry point: starts the daemon, wires SIGINT/SIGTERM to a clean stop + exit. */
export function runDaemonProcess(options: RunDaemonProcessOptions): void {
	const daemon = startDaemon(options);
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
