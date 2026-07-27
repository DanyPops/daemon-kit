#!/usr/bin/env bun
/**
 * Test fixture standing in for a real supervised daemon. Appends one JSON
 * line per start (`start:<json env dump>`) to the log file given as argv[2],
 * so a test can observe multiple restarts across the same file and assert on
 * any env var name. If EXIT_CODE is set, exits with that code shortly after
 * starting (simulating a crash); otherwise runs until asked to stop via
 * awaitGracefulShutdown() -- real SIGTERM on POSIX, or the stdin fallback a
 * test can exercise directly to prove the Windows path without a Windows
 * host -- exiting 0, a real graceful shutdown rather than a forced kill.
 */
import { appendFileSync } from "node:fs";
import { awaitGracefulShutdown } from "../../src/supervisor.ts";

const logPath = process.argv[2];
if (!logPath) throw new Error("usage: restartable-unit.ts <log-path>");

appendFileSync(logPath, `start:${JSON.stringify(process.env)}\n`);

awaitGracefulShutdown(() => {
	appendFileSync(logPath, "sigterm\n");
	process.exit(0);
});

if (process.env.EXIT_CODE !== undefined) {
	setTimeout(() => process.exit(Number(process.env.EXIT_CODE)), 30);
} else {
	setInterval(() => {}, 60_000); // keep the process alive until told to stop
}
