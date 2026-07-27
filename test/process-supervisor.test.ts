/**
 * Real subprocess spawns via a fixture daemon -- restart policy, planned
 * restarts, and the shutdown contract all need to be observed against actual
 * child processes, not asserted against a mock scheduler. Mirrors the test
 * shape this module was generalized from (Enigma's own test/supervisor.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessSupervisor, type SupervisedUnitConfig } from "../src/process-supervisor.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "restartable-unit.ts");

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "daemon-kit-process-supervisor-"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("waitFor timed out");
}

function readLog(path: string): string[] {
	try {
		return readFileSync(path, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function startCount(path: string): number {
	return readLog(path).filter((line) => line.startsWith("start:")).length;
}

describe("runProcessSupervisor", () => {
	it("calls resolveEnv fresh at every (re)launch and injects its result into the real child env", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			let calls = 0;
			const units: SupervisedUnitConfig[] = [{
				name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [], restart: "always", env: { EXIT_CODE: "0" },
				resolveEnv: () => { calls += 1; return { PROBE_TOKEN: `value-${calls}` }; },
			}];
			const supervisor = runProcessSupervisor(units);
			try {
				await waitFor(() => startCount(logPath) >= 2, 4_000);
				const lines = readLog(logPath).filter((line) => line.startsWith("start:"));
				expect(JSON.parse(lines[0]!.slice("start:".length)).PROBE_TOKEN).toBe("value-1");
				expect(JSON.parse(lines[1]!.slice("start:".length)).PROBE_TOKEN).toBe("value-2");
			} finally {
				await supervisor.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restart: always relaunches after a clean exit", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const units: SupervisedUnitConfig[] = [{ name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [], env: { EXIT_CODE: "0" }, restart: "always" }];
			const supervisor = runProcessSupervisor(units);
			try {
				await waitFor(() => startCount(logPath) >= 2, 4_000);
			} finally {
				await supervisor.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restart: on-failure does not relaunch after a clean (code 0) exit", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const units: SupervisedUnitConfig[] = [{ name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [], env: { EXIT_CODE: "0" }, restart: "on-failure" }];
			const supervisor = runProcessSupervisor(units);
			try {
				await waitFor(() => startCount(logPath) >= 1);
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(startCount(logPath)).toBe(1);
			} finally {
				await supervisor.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restart: on-failure relaunches after a nonzero exit", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const units: SupervisedUnitConfig[] = [{ name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [], env: { EXIT_CODE: "1" }, restart: "on-failure" }];
			const supervisor = runProcessSupervisor(units);
			try {
				await waitFor(() => startCount(logPath) >= 2, 4_000);
			} finally {
				await supervisor.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("default restart policy (no) does not relaunch at all", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const units: SupervisedUnitConfig[] = [{ name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [], env: { EXIT_CODE: "1" } }];
			const supervisor = runProcessSupervisor(units);
			try {
				await waitFor(() => startCount(logPath) >= 1);
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(startCount(logPath)).toBe(1);
			} finally {
				await supervisor.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restarts a unit with fresh env once shouldPlannedRestart fires, even with restart: no", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			let generation = 0;
			let due = true;
			const units: SupervisedUnitConfig[] = [{
				name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [], restart: "no",
				resolveEnv: () => ({ GENERATION: String(++generation) }),
				shouldPlannedRestart: () => due,
			}];
			const supervisor = runProcessSupervisor(units, { plannedRestartCheckMs: 50 });
			try {
				await waitFor(() => startCount(logPath) >= 2, 4_000);
				due = false; // stop retriggering once we've observed the one planned restart we're testing for
				expect(readLog(logPath)).toContain("sigterm");
			} finally {
				await supervisor.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restartUnit() triggers an explicit planned restart independent of the periodic check, and is a no-op for an unknown name", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const units: SupervisedUnitConfig[] = [{ name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [], restart: "no" }];
			// A long check interval proves the restart came from the explicit call, not the timer.
			const supervisor = runProcessSupervisor(units, { plannedRestartCheckMs: 60_000 });
			try {
				await waitFor(() => startCount(logPath) >= 1);
				supervisor.restartUnit("does-not-exist"); // must not throw, must not affect "probe"
				supervisor.restartUnit("probe");
				await waitFor(() => startCount(logPath) >= 2, 4_000);
				expect(readLog(logPath)).toContain("sigterm");
			} finally {
				await supervisor.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stop() sends SIGTERM to every unit and resolves only once they've all exited", async () => {
		const dir = tmpDir();
		try {
			const logPathA = join(dir, "log-a.txt");
			const logPathB = join(dir, "log-b.txt");
			const units: SupervisedUnitConfig[] = [
				{ name: "a", bin: "bun", args: [FIXTURE, logPathA], backends: [] },
				{ name: "b", bin: "bun", args: [FIXTURE, logPathB], backends: [] },
			];
			const supervisor = runProcessSupervisor(units);
			await waitFor(() => startCount(logPathA) >= 1 && startCount(logPathB) >= 1);

			await supervisor.stop();
			expect(readLog(logPathA)).toContain("sigterm");
			expect(readLog(logPathB)).toContain("sigterm");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
