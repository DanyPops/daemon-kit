/**
 * Real subprocess, real stdin pipe -- proves the actual mechanism
 * requestGracefulShutdown()/awaitGracefulShutdown() rely on, not a
 * reimplementation. The genuinely Windows-only fact (ChildProcess.kill(
 * "SIGTERM") unconditionally terminates without invoking a handler) can't be
 * observed on this host OS -- spawnUnit's injectable `platform` option
 * (mirroring paths.ts/service.ts's own established pattern) exercises the
 * Windows *code path* for real: an actual write to an actual child's stdin,
 * received and acted on by an actual awaitGracefulShutdown() call in that
 * child, exiting cleanly -- exactly what a real Windows unit would do
 * differently only in which branch of spawnUnit sends the notification.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonUnit, spawnUnit } from "../src/supervisor.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "restartable-unit.ts");

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "daemon-kit-graceful-shutdown-"));
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

describe("requestGracefulShutdown()", () => {
	it("on a POSIX platform, delivers a real SIGTERM the unit can observe and act on", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const unit: DaemonUnit = { name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [] };
			const spawned = spawnUnit(unit, {}, { platform: "linux" });
			await waitFor(() => readLog(logPath).some((line) => line.startsWith("start:")));

			spawned.requestGracefulShutdown();
			expect(await spawned.exited).toBe(0);
			expect(readLog(logPath)).toContain("sigterm");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("on Windows, writes the fallback line to the real child's stdin instead of sending a signal, and the unit reacts identically", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const unit: DaemonUnit = { name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [] };
			const spawned = spawnUnit(unit, {}, { platform: "win32" });
			await waitFor(() => readLog(logPath).some((line) => line.startsWith("start:")));

			spawned.requestGracefulShutdown();
			expect(await spawned.exited).toBe(0);
			expect(readLog(logPath)).toContain("sigterm");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a real SIGTERM sent directly (bypassing requestGracefulShutdown) still works -- awaitGracefulShutdown does not regress the POSIX path", async () => {
		const dir = tmpDir();
		try {
			const logPath = join(dir, "log.txt");
			const unit: DaemonUnit = { name: "probe", bin: "bun", args: [FIXTURE, logPath], backends: [] };
			const spawned = spawnUnit(unit);
			await waitFor(() => readLog(logPath).some((line) => line.startsWith("start:")));

			spawned.kill("SIGTERM");
			expect(await spawned.exited).toBe(0);
			expect(readLog(logPath)).toContain("sigterm");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
