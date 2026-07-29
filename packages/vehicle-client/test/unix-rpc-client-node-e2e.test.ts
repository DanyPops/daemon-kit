/**
 * Proves connectUnixRpc's client path for real under a real `node` process,
 * never Bun -- the same gap daemon-node-e2e.test.ts closes for daemon.ts.
 * `bun test` itself always runs under Bun, so every other test in this
 * file's suite would silently pass even if the Node path threw
 * "Bun is not defined" the moment a real Node-side consumer (a Pi
 * extension, e.g. Enigma's) used it against a live Unix-socket server.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serveUnixRpc } from "@danypops/vehicle-server/unix-rpc-server";

const UNIX_RPC_CLIENT_TS = resolve(import.meta.dir, "..", "src", "unix-rpc-client.ts");

function socketPath(): string {
	return join(tmpdir(), `daemon-kit-unix-rpc-client-node-e2e-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/**
 * Runs `node scriptPath` to completion without blocking this (Bun) process's
 * own event loop -- `spawnSync` would, and the server under test in these
 * cases lives right here in the parent process: a synchronous wait blocks
 * the very event loop needed to accept the child's connection, deadlocking
 * until the child's own timeout fires. Confirmed live while writing this
 * test (`spawnSync` reproduced a false "Bun is not defined"-shaped failure
 * that was actually this deadlock, not the real bug).
 */
function runNode(scriptPath: string, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn("node", [scriptPath], { timeout: timeoutMs });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
	});
}

describe("connectUnixRpc under a real Node process (not Bun)", () => {
	it("round-trips a real GET against a live serveUnixRpc server", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async (request) => {
				if (new URL(request.url).pathname !== "/whoami") return new Response("not found", { status: 404 });
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
			},
		});

		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-unix-rpc-client-node-e2e-"));
		const scriptPath = join(dir, "check.mjs");
		writeFileSync(
			scriptPath,
			`
			import { connectUnixRpc } from ${JSON.stringify(UNIX_RPC_CLIENT_TS)};

			if (typeof globalThis.Bun !== "undefined") throw new Error("expected to run under Node, not Bun");

			const transport = connectUnixRpc({ path: ${JSON.stringify(path)} });
			const response = await transport(new Request("http://unix.local/whoami"));
			const body = await response.json();
			if (response.status !== 200 || body.ok !== true) {
				throw new Error("round trip failed: " + response.status + " " + JSON.stringify(body));
			}
			console.log("NODE_E2E_OK");
			`,
		);

		try {
			// Explicitly "node", not process.execPath -- under `bun test` (which is how
			// this very file runs), process.execPath resolves to Bun itself, which would
			// silently defeat the entire point of this test. Async, not spawnSync: the
			// server under test lives in this same process, and a synchronous wait would
			// block the event loop it needs to accept the child's connection.
			const result = await runNode(scriptPath, 15_000);
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().endsWith("NODE_E2E_OK")).toBe(true);
			expect(result.status).toBe(0);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects, rather than crashing with a runtime error, when nothing is listening at the path", async () => {
		const path = socketPath(); // never bound by any server
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-unix-rpc-client-node-e2e-"));
		const scriptPath = join(dir, "check.mjs");
		writeFileSync(
			scriptPath,
			`
			import { connectUnixRpc } from ${JSON.stringify(UNIX_RPC_CLIENT_TS)};

			const transport = connectUnixRpc({ path: ${JSON.stringify(path)}, timeoutMs: 1000 });
			try {
				await transport(new Request("http://unix.local/whoami"));
				console.log("NODE_E2E_SHOULD_HAVE_REJECTED");
			} catch (error) {
				console.log("NODE_E2E_REJECTED:" + error.message);
			}
			`,
		);

		try {
			const result = await runNode(scriptPath, 15_000);
			expect(result.stdout).toContain("NODE_E2E_REJECTED:");
			expect(result.stdout).not.toContain("Bun is not defined");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
