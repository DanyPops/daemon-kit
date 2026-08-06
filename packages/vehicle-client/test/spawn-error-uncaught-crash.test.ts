/**
 * A spawn() failure (missing binPath, bad permissions, wrong interpreter) surfaces
 * asynchronously as an "error" event on the ChildProcess. Every SpawnDetachedDaemonOptions.spawn
 * implementation in this repo creates the child, calls unref(), and nothing else -- with no
 * listener, that error is an uncaught exception that kills the whole host process, not just
 * the one connect attempt. Each scenario runs in a real separate process: an uncaught
 * exception can only be observed via a child's own exit code/stderr, not caught inline.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs under real Node, not whichever runtime executes this test -- Bun's spawn() throws
 * this same ENOENT synchronously at the call site, a materially different crash shape than
 * Node's async unlistened 'error' event. */
function runScript(scriptPath: string): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn("node", [scriptPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
	});
}

describe("spawn() + unref() with no error listener crashes the whole host process on a spawn failure", () => {
	let dir: string | undefined;

	function writeVulnerableScript(): string {
		dir = mkdtempSync(join(tmpdir(), "vehicle-spawn-crash-"));
		const path = join(dir, "vulnerable.mjs");
		writeFileSync(
			path,
			`
			import { spawn } from "node:child_process";
			// Every SpawnDetachedDaemonOptions.spawn implementation in this house does this: spawn, unref, nothing else.
			const child = spawn("/definitely/does/not/exist/cli.ts", ["serve"], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			// Gives the async ENOENT "error" event time to fire before the process exits on its own.
			setTimeout(() => console.log("REACHED_END_WITHOUT_CRASHING"), 300);
			`,
		);
		return path;
	}

	function writeFixedScript(): string {
		dir = mkdtempSync(join(tmpdir(), "vehicle-spawn-fixed-"));
		const path = join(dir, "fixed.mjs");
		writeFileSync(
			path,
			`
			import { spawn } from "node:child_process";
			const child = spawn("/definitely/does/not/exist/cli.ts", ["serve"], {
				detached: true,
				stdio: "ignore",
			});
			// The fix: whoever owns unref() must also own error handling.
			child.on("error", (error) => {
				console.log(\`CAUGHT: \${error.code} \${error.syscall}\`);
			});
			child.unref();
			setTimeout(() => console.log("REACHED_END_WITHOUT_CRASHING"), 300);
			`,
		);
		return path;
	}

	it("RED: a missing binPath crashes the whole process with an uncaught 'spawn ... ENOENT' exception, matching the live incident's exact stack shape", async () => {
		const scriptPath = writeVulnerableScript();
		const result = await runScript(scriptPath);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Error: spawn /definitely/does/not/exist/cli.ts ENOENT");
		// The async, unlistened 'error' event path, not a synchronous throw at the call site.
		expect(result.stderr).toContain("at ChildProcess._handle.onexit");
		expect(result.stderr).toContain("at onErrorNT");
		expect(result.stderr).toContain("code: 'ENOENT'");
		// Never reached -- the uncaught exception kills the process first.
		expect(result.stdout).not.toContain("REACHED_END_WITHOUT_CRASHING");

		if (dir) rmSync(dir, { recursive: true, force: true });
	}, 10_000);

	it("GREEN: the same missing binPath, with an error listener attached, never crashes -- the failure is caught and the process continues normally", async () => {
		const scriptPath = writeFixedScript();
		const result = await runScript(scriptPath);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("CAUGHT: ENOENT spawn /definitely/does/not/exist/cli.ts");
		expect(result.stdout).toContain("REACHED_END_WITHOUT_CRASHING");
		expect(result.stderr).not.toContain("Uncaught");

		if (dir) rmSync(dir, { recursive: true, force: true });
	}, 10_000);
});
