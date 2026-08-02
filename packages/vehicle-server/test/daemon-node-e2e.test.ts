/**
 * Proves daemon.ts's Node code path for real, not just at the type level:
 * spawns an actual `node` binary (never `bun`) running a small script that
 * imports daemon.ts directly and drives a real HTTP round trip against it.
 * `bun test` itself always runs under Bun, so every other test in this
 * package's suite would silently exercise the Bun.serve() path even if the
 * Node branch were completely broken -- this is the one test that can't.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DAEMON_TS = resolve(import.meta.dir, "..", "src", "daemon.ts");

describe("daemon.ts under a real Node process (not Bun)", () => {
	it("binds via node:http, serves a real GET and POST round trip, and shuts down cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-node-e2e-"));
		const handlePath = join(dir, "handle.json");
		const scriptPath = join(dir, "check.mjs");
		writeFileSync(
			scriptPath,
			`
			import { startDaemon } from ${JSON.stringify(DAEMON_TS)};

			const daemon = await startDaemon({
				daemonLabel: "NodeE2E",
				handlePath: ${JSON.stringify(handlePath)},
				buildApp: () => ({
					async fetch(request) {
						if (request.method === "POST") {
							const body = await request.text();
							return new Response("echo:" + body, { status: 200, headers: { "x-check": "1" } });
						}
						return new Response("ok", { status: 200 });
					},
				}),
			});

			if (typeof globalThis.Bun !== "undefined") throw new Error("expected to run under Node, not Bun");

			const getResponse = await fetch("http://127.0.0.1:" + daemon.port + "/");
			if (getResponse.status !== 200 || (await getResponse.text()) !== "ok") throw new Error("GET round trip failed");

			const postResponse = await fetch("http://127.0.0.1:" + daemon.port + "/", { method: "POST", body: "hello-node" });
			const postBody = await postResponse.text();
			if (postResponse.status !== 200 || postBody !== "echo:hello-node" || postResponse.headers.get("x-check") !== "1") {
				throw new Error("POST round trip failed: " + postResponse.status + " " + postBody);
			}

			await daemon.stop();
			console.log("NODE_E2E_OK");
			`,
		);

		try {
			// Explicitly "node", not process.execPath -- under `bun test` (which is
			// how this very file runs), process.execPath resolves to Bun itself,
			// which would silently defeat the entire point of this test.
			const result = spawnSync("node", [scriptPath], { encoding: "utf8", timeout: 15_000 });
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().endsWith("NODE_E2E_OK")).toBe(true);
			expect(result.status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a pushChannel option under Node with an actionable error instead of silently ignoring it", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-node-e2e-"));
		const handlePath = join(dir, "handle.json");
		const scriptPath = join(dir, "check.mjs");
		writeFileSync(
			scriptPath,
			`
			import { startDaemon } from ${JSON.stringify(DAEMON_TS)};

			try {
				await startDaemon({
					daemonLabel: "NodeE2E",
					handlePath: ${JSON.stringify(handlePath)},
					buildApp: () => ({ async fetch() { return new Response("ok"); } }),
					pushChannel: {},
				});
				console.log("NODE_E2E_SHOULD_HAVE_THROWN");
			} catch (error) {
				console.log("NODE_E2E_REJECTED:" + error.message);
			}
			`,
		);

		try {
			const result = spawnSync("node", [scriptPath], { encoding: "utf8", timeout: 15_000 });
			expect(result.stdout).toContain("NODE_E2E_REJECTED:");
			expect(result.stdout).toContain("pushChannel requires the Bun runtime");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("binds a real rpcCallId for each inbound request under the Node listener too, not just Bun's", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-node-e2e-"));
		const handlePath = join(dir, "handle.json");
		const scriptPath = join(dir, "check.mjs");
		writeFileSync(
			scriptPath,
			`
			import { startDaemon } from ${JSON.stringify(DAEMON_TS)};
			import { getCurrentRpcCallId } from ${JSON.stringify(resolve(import.meta.dir, "..", "src", "rpc-correlation.ts"))};

			const daemon = await startDaemon({
				daemonLabel: "NodeE2E",
				handlePath: ${JSON.stringify(handlePath)},
				buildApp: () => ({
					async fetch() {
						return Response.json({ rpcCallId: getCurrentRpcCallId() });
					},
				}),
			});

			const response = await fetch("http://127.0.0.1:" + daemon.port + "/");
			const body = await response.json();
			if (typeof body.rpcCallId !== "string" || body.rpcCallId.length === 0) {
				throw new Error("expected a real rpcCallId, got: " + JSON.stringify(body));
			}

			await daemon.stop();
			console.log("NODE_E2E_OK");
			`,
		);

		try {
			const result = spawnSync("node", [scriptPath], { encoding: "utf8", timeout: 15_000 });
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().endsWith("NODE_E2E_OK")).toBe(true);
			expect(result.status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
