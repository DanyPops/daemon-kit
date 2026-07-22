/**
 * Walking-skeleton test: wires every module together (paths, storage,
 * logging, http, daemon, rpc-client) into one trivial-but-real daemon,
 * end to end, exactly the way a real @danypops daemon would. Proves the
 * architecture before any of the four real daemons migrate onto it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAuthToken, readDaemonHandle, resolveDaemonPaths } from "../src/paths.ts";
import { openSqliteWithPragmas, checkpoint, optimize } from "../src/storage.ts";
import { createLogger } from "../src/logging.ts";
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "../src/http.ts";
import { runDaemonProcess, startDaemon, type RunningDaemon } from "../src/daemon.ts";
import { AuthenticatedRpcClient } from "../src/rpc-client.ts";

type Ops = { "echo.ping": { message: string } };
type Outs = { "echo.ping": { message: string; row: unknown } };

function buildTestPaths(root: string) {
	return resolveDaemonPaths(
		{
			stateDirectoryName: "daemon-kit-skeleton-test",
			databaseFilename: "test.db",
			tokenFilename: "token",
			handleFilename: "handle.json",
			systemdUnitName: "daemon-kit-skeleton-test.service",
		},
		{ env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root } },
	);
}

let daemon: RunningDaemon | undefined;
let tmpRoot: string | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	tmpRoot = undefined;
});

describe("walking skeleton — a real daemon built from every module", () => {
	it("boots, authenticates, migrates, serves ops, logs maintenance, and shuts down cleanly", async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "daemon-kit-skeleton-"));
		const paths = buildTestPaths(tmpRoot);
		const token = ensureAuthToken(paths.token, "Skeleton");

		const db = openSqliteWithPragmas(paths.database, {
			migrations: [{ version: 1, up: (d) => d.exec("CREATE TABLE pings (message TEXT NOT NULL)") }],
		});

		const logLines: string[] = [];
		const logger = createLogger("skeleton", {
			level: "debug",
			destination: { write: (chunk: string) => { logLines.push(chunk); return true; } },
		});

		let maintenanceRuns = 0;
		daemon = startDaemon({
			daemonLabel: "Skeleton",
			handlePath: paths.handle,
			logger,
			maintenanceTasks: [
				{ name: "checkpoint", intervalMs: 10, run: () => { checkpoint(db); maintenanceRuns++; } },
				{ name: "always-fails", intervalMs: 10, run: () => { throw new Error("boom"); } },
			],
			buildApp: () => ({
				async fetch(request: Request): Promise<Response> {
					const url = new URL(request.url);
					if (!requireBearerToken(request, token)) return errorResponse("unauthorized", 401);
					if (request.method === "GET" && url.pathname === "/health") return healthResponse("0.0.0-skeleton");
					if (request.method === "GET" && url.pathname === "/ready") return readyResponse(true);
					if (request.method === "POST" && url.pathname === "/api/v1/ops") {
						const body = (await request.json()) as { op: string; input: { message: string } };
						if (body.op !== "echo.ping") return errorResponse(`unknown op: ${body.op}`, 400);
						db.query("INSERT INTO pings (message) VALUES (?)").run(body.input.message);
						const row = db.query("SELECT message FROM pings ORDER BY rowid DESC LIMIT 1").get();
						return jsonResponse({ result: { message: body.input.message, row } });
					}
					if (request.method === "GET" && url.pathname === "/api/v1/ops") return jsonResponse({ operations: ["echo.ping"] });
					return errorResponse("not found", 404);
				},
			}),
		});

		// The handle file is real, atomic, and matches what was actually bound.
		const handle = readDaemonHandle(paths.handle);
		expect(handle).not.toBeNull();
		expect(handle?.port).toBe(daemon.port);
		expect(handle?.pid).toBe(process.pid);

		const client = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>(
			`http://${daemon.host}:${daemon.port}`,
			token,
			{ label: "Skeleton" },
		);

		expect(await client.health()).toEqual({ ok: true, version: "0.0.0-skeleton" });
		expect(await client.ready()).toBe(true);
		expect(await client.operations()).toEqual(["echo.ping"]);

		const result = await client.call("echo.ping", { message: "hello" });
		expect(result.message).toBe("hello");
		expect(result.row).toEqual({ message: "hello" });

		// Wrong token is rejected before any op runs.
		const badClient = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>(
			`http://${daemon.host}:${daemon.port}`,
			"wrong-token",
			{ label: "Skeleton" },
		);
		await expect(badClient.health()).rejects.toThrow();

		// Maintenance tasks actually ran, and a failing one didn't crash the daemon or the passing one.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(maintenanceRuns).toBeGreaterThan(0);
		const logged = logLines.join("");
		expect(logged).toContain("maintenance task failed: always-fails");
		expect(logged).toContain('"level":"error"');

		optimize(db);
		db.close();

		await daemon.stop();
		daemon = undefined;

		// Clean shutdown removes the handle file.
		expect(readDaemonHandle(paths.handle)).toBeNull();
	});

	it("runDaemonProcess wires SIGINT/SIGTERM without double-registering on repeated signals", async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "daemon-kit-skeleton-proc-"));
		const paths = buildTestPaths(tmpRoot);
		let listened: { host: string; port: number } | undefined;

		const originalExit = process.exit;
		let exitCode: number | undefined;
		process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
		try {
			runDaemonProcess({
				daemonLabel: "Skeleton",
				handlePath: paths.handle,
				onListen: (info) => { listened = info; },
				buildApp: () => ({ async fetch() { return errorResponse("not found", 404); } }),
			});
			expect(listened?.port).toBeGreaterThan(0);
			process.emit("SIGTERM");
			process.emit("SIGTERM"); // idempotent -- must not throw or double-stop
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(exitCode).toBe(0);
		} finally {
			process.exit = originalExit;
		}
	});
});
