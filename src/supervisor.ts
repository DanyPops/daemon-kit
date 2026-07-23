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
	kill(signal?: NodeJS.Signals | number): void;
}

/**
 * Spawns one unit with `credsEnv` merged over `unit.env` merged over the
 * current process env — credentials take precedence over a unit's own
 * static config in case of an accidental name collision, since a stale
 * hardcoded value should never silently shadow a freshly fetched one.
 */
export function spawnUnit(unit: DaemonUnit, credsEnv: Record<string, string> = {}): SpawnedUnit {
	const child = Bun.spawn([unit.bin, ...(unit.args ?? [])], {
		env: { ...process.env, ...unit.env, ...credsEnv },
		stdio: ["ignore", "inherit", "inherit"],
	});

	return {
		name: unit.name,
		pid: child.pid,
		exited: child.exited,
		kill: (signal) => child.kill(signal as number | undefined),
	};
}
