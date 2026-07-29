/**
 * Minimal subprocess-spawn primitive for a daemon that supervises other
 * daemons (e.g. enigma spawning pipes-daemon/tickets-daemon with credentials
 * injected as env). Deliberately not a process manager: restart policy,
 * exit-code handling, and unit lifecycle belong to the caller. This module's
 * only job is "start one subprocess with these extra env vars," reliably.
 */

export interface DaemonUnit {
	name: string;
	/** Path to a `#!/usr/bin/env bun` daemon entry point. */
	bin: string;
	args?: string[];
	/** Non-secret env forwarded to the child as-is. */
	env?: Record<string, string>;
	/** Credential backend names this unit needs — resolved and injected by the caller, not by spawnUnit itself. */
	backends: string[];
	restart?: "always" | "on-failure" | "no";
}

export interface SupervisorConfig {
	units: DaemonUnit[];
}

export interface SpawnedUnit {
	name: string;
	pid: number;
	exited: Promise<number>;
	/** Raw signal delivery -- on Windows, Node/Bun's kill("SIGTERM") unconditionally terminates the process without ever invoking a handler. Prefer requestGracefulShutdown() for "let the unit clean up first"; reach for kill() only when an immediate, unconditional stop is actually what's wanted (e.g. SIGKILL). */
	kill(signal?: NodeJS.Signals | number): void;
	/**
	 * Cross-platform graceful shutdown: a real SIGTERM on POSIX (unchanged
	 * behavior), or -- on Windows, where SIGTERM cannot be delivered to a
	 * child at all -- a magic line written to the unit's stdin instead. A
	 * unit that calls awaitGracefulShutdown() (below) reacts identically to
	 * either path; a unit that hand-rolls its own `process.on("SIGTERM", ...)`
	 * and nothing else will not see the Windows fallback and needs
	 * migrating to that helper (or kill()'d forcefully) to actually stop
	 * gracefully there.
	 */
	requestGracefulShutdown(): void;
}

export interface SpawnUnitOptions {
	/** Defaults to process.platform. Injectable so a test can exercise the Windows fallback path from any host OS. */
	platform?: NodeJS.Platform;
}

/**
 * Newline-terminated so a line-oriented reader sees exactly one complete
 * message per write; NUL-prefixed to make an accidental collision with a
 * unit's own real stdin traffic vanishingly unlikely (none of this
 * package's own units read stdin for anything today, but a future one might).
 */
const GRACEFUL_SHUTDOWN_STDIN_LINE = "\u0000vehicle-server:graceful-shutdown\n";

/**
 * Spawns one unit with `credsEnv` merged over `unit.env` merged over the
 * current process env — credentials take precedence over a unit's own
 * static config in case of an accidental name collision, since a stale
 * hardcoded value should never silently shadow a freshly fetched one.
 *
 * stdin is piped (not the prior "ignore") so requestGracefulShutdown() has
 * somewhere to write its Windows fallback; nothing about a unit's own
 * stdout/stderr inheritance changes.
 */
export function spawnUnit(unit: DaemonUnit, credsEnv: Record<string, string> = {}, options: SpawnUnitOptions = {}): SpawnedUnit {
	const platform = options.platform ?? process.platform;
	const child = Bun.spawn([unit.bin, ...(unit.args ?? [])], {
		env: { ...process.env, ...unit.env, ...credsEnv },
		stdio: ["pipe", "inherit", "inherit"],
	});

	return {
		name: unit.name,
		pid: child.pid,
		exited: child.exited,
		kill: (signal) => child.kill(signal as number | undefined),
		requestGracefulShutdown: () => {
			if (platform === "win32") {
				void child.stdin.write(GRACEFUL_SHUTDOWN_STDIN_LINE);
				void child.stdin.flush();
			} else {
				child.kill("SIGTERM");
			}
		},
	};
}

/**
 * Counterpart to requestGracefulShutdown(): a unit spawned via spawnUnit()
 * calls this once at startup to be notified the same way whether it was
 * asked to stop via a real SIGINT/SIGTERM (POSIX) or the stdin fallback
 * (Windows) -- so the unit itself never needs its own platform branch.
 * Reads process.stdin directly (a standard Node API, implemented the same
 * way under Bun), not anything spawnUnit-specific.
 */
export function awaitGracefulShutdown(onShutdown: () => void): void {
	let fired = false;
	const fire = (): void => {
		if (fired) return;
		fired = true;
		onShutdown();
	};
	process.on("SIGINT", fire);
	process.on("SIGTERM", fire);
	process.stdin.on("data", (chunk: Buffer | string) => {
		if (chunk.toString().includes(GRACEFUL_SHUTDOWN_STDIN_LINE.trim())) fire();
	});
}
