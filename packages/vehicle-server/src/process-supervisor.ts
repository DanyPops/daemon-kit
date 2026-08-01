/**
 * Generalizes what a supervisor built on top of spawnUnit() (see supervisor.ts)
 * always ends up building for itself: restart-policy interpretation, a planned-
 * restart escape hatch for a reason other than a crash (e.g. credential refresh),
 * a pluggable periodic-trigger loop, and the shutdown contract. Read directly
 * from a real, tested caller (Enigma's own src/supervisor.ts) rather than
 * designed in the abstract -- everything here is generic; a caller's own env
 * resolution and "is this unit due for a restart" predicate stay with the
 * caller via resolveEnv/shouldPlannedRestart, not hardcoded here.
 */

import type { Logger } from "./logging.js";
import { type DaemonUnit, type SpawnedUnit, spawnUnit } from "./supervisor.js";

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEFAULT_PLANNED_RESTART_CHECK_MS = 30_000;

export interface SupervisedUnitConfig extends DaemonUnit {
	/** Called fresh at every (re)launch, not once at supervisor start -- a caller resolving secrets per spawn rather than reusing a stale snapshot. */
	resolveEnv?: () => Record<string, string>;
	/** Checked on a timer (plannedRestartCheckMs); true triggers a kill-and-relaunch that bypasses restart policy entirely, for a reason other than a crash. */
	shouldPlannedRestart?: () => boolean;
}

export interface RunProcessSupervisorOptions {
	logger?: Logger;
	/** Defaults to 30s. */
	plannedRestartCheckMs?: number;
}

export interface RunningProcessSupervisor {
	/** Documented shutdown contract: every unit gets SIGTERM and stop() resolves only once all of them have actually exited. */
	stop(): Promise<void>;
	/** Kills and relaunches a unit bypassing restart policy entirely -- an explicit external trigger, independent of the periodic shouldPlannedRestart check. A no-op for an unknown or already-stopped unit name. */
	restartUnit(name: string): void;
}

interface ManagedUnit {
	unit: SupervisedUnitConfig;
	current?: SpawnedUnit;
	stopping: boolean;
	/** Set just before a planned kill so the exit handler relaunches unconditionally, bypassing restart policy -- policy governs unplanned exits (crashes), not a restart this supervisor itself initiated. */
	refreshing: boolean;
}

export function runProcessSupervisor(units: SupervisedUnitConfig[], options: RunProcessSupervisorOptions = {}): RunningProcessSupervisor {
	const logger = options.logger ?? NOOP_LOGGER;
	const managed: ManagedUnit[] = units.map((unit) => ({ unit, stopping: false, refreshing: false }));

	function launch(entry: ManagedUnit): void {
		const env = entry.unit.resolveEnv?.() ?? {};
		const spawned = spawnUnit(entry.unit, env);
		entry.current = spawned;
		logger.info("unit started", { name: entry.unit.name, pid: spawned.pid });

		void spawned.exited.then((code) => {
			if (entry.stopping) return;
			logger.info("unit exited", { name: entry.unit.name, code });
			if (entry.refreshing) {
				entry.refreshing = false;
				launch(entry);
				return;
			}
			const policy = entry.unit.restart ?? "no";
			const shouldRestart = policy === "always" || (policy === "on-failure" && code !== 0);
			if (shouldRestart) launch(entry);
		});
	}

	for (const entry of managed) launch(entry);

	function plannedRestart(entry: ManagedUnit, reason: string): void {
		if (entry.stopping || !entry.current) return;
		logger.info("planned restart", { name: entry.unit.name, reason });
		entry.refreshing = true;
		entry.current.requestGracefulShutdown();
		// The exited-promise handler above launches the replacement once this
		// process actually exits; not launched here to avoid a double-spawn race.
	}

	const plannedRestartTimer = setInterval(() => {
		for (const entry of managed) {
			if (entry.unit.shouldPlannedRestart?.()) plannedRestart(entry, "shouldPlannedRestart");
		}
	}, options.plannedRestartCheckMs ?? DEFAULT_PLANNED_RESTART_CHECK_MS);

	return {
		restartUnit(name: string): void {
			const entry = managed.find((m) => m.unit.name === name);
			if (entry) plannedRestart(entry, "restartUnit");
		},
		async stop(): Promise<void> {
			clearInterval(plannedRestartTimer);
			for (const entry of managed) {
				entry.stopping = true;
				entry.current?.requestGracefulShutdown();
			}
			await Promise.all(managed.map((entry) => entry.current?.exited).filter((p): p is Promise<number> => p !== undefined));
		},
	};
}
