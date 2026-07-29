/**
 * Regression test for the exact gap "daemon-kit: ship daemon.ts (and its raw-TS
 * dependents) pre-compiled for plain-Node consumers" was filed to close:
 * installing @danypops/vehicle-server and importing its `./daemon` export from
 * plain `node`, no bundler, no ts-node/tsx, used to fail immediately with
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING -- Node refuses to type-strip
 * *any* .ts file under a node_modules path (confirmed directly against
 * nodejs.org/api/typescript.html's own "Type stripping in dependencies"
 * section), a blanket policy with no override flag.
 *
 * Simulates a real node_modules layout by copying this package's own build
 * output (never a raw .ts file) into a fake node_modules/@danypops/vehicle-server,
 * rather than a real `npm install` -- hermetic and fast (no network), while
 * still exercising the one thing that actually matters: is the file Node
 * sees under node_modules a real .js file or a .ts file needing stripping.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

describe("plain-Node consumption of a real (simulated) node_modules install", () => {
	beforeAll(() => {
		// Independently runnable regardless of test ordering/CI step order --
		// this test's whole point depends on dist/daemon.js being the real
		// compiled artifact, not a stale or missing one.
		const result = spawnSync("bun", ["run", "build:daemon"], { cwd: PACKAGE_ROOT, stdio: "inherit" });
		if (result.status !== 0) throw new Error("bun run build:daemon failed -- see output above");
	});

	it("importing @danypops/vehicle-server/daemon under plain `node` with no bundler succeeds and round-trips real HTTP", () => {
		const workDir = mkdtempSync(join(tmpdir(), "vehicle-server-plain-node-"));
		try {
			const fakeNodeModules = join(workDir, "node_modules");
			const packageDir = join(fakeNodeModules, "@danypops", "vehicle-server");
			mkdirSync(packageDir, { recursive: true });

			// Only what a real npm install would place there: compiled dist/,
			// the package manifest, and this package's own real runtime
			// dependency (pino) -- never raw src/.
			cpSync(join(PACKAGE_ROOT, "dist"), join(packageDir, "dist"), { recursive: true });
			cpSync(join(PACKAGE_ROOT, "package.json"), join(packageDir, "package.json"));
			mkdirSync(join(fakeNodeModules, "pino"), { recursive: true });
			cpSync(join(PACKAGE_ROOT, "node_modules", "pino"), join(fakeNodeModules, "pino"), { recursive: true });

			const scriptPath = join(workDir, "consumer.mjs");
			writeFileSync(
				scriptPath,
				`
				import { startDaemon } from "@danypops/vehicle-server/daemon";
				import { mkdtempSync } from "node:fs";
				import { tmpdir } from "node:os";
				import { join } from "node:path";

				const dir = mkdtempSync(join(tmpdir(), "vehicle-server-plain-node-run-"));
				const daemon = await startDaemon({
					daemonLabel: "PlainNodeCheck",
					handlePath: join(dir, "handle.json"),
					buildApp: () => ({ async fetch() { return new Response("ok"); } }),
				});
				const response = await fetch("http://127.0.0.1:" + daemon.port + "/");
				if (response.status !== 200 || (await response.text()) !== "ok") throw new Error("round trip failed");
				await daemon.stop();
				console.log("PLAIN_NODE_CONSUMER_OK");
				`,
			);

			const result = spawnSync("node", [scriptPath], { cwd: workDir, encoding: "utf8", timeout: 15_000 });
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().endsWith("PLAIN_NODE_CONSUMER_OK")).toBe(true);
			expect(result.status).toBe(0);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("the compiled daemon.d.ts contains no Bun-specific type references, so a consumer's own tsc build (with no bun-types installed) can type-check it", () => {
		const compiled = readFileSync(join(PACKAGE_ROOT, "dist", "daemon.d.ts"), "utf8");
		expect(compiled).not.toMatch(/\bBun\b/);
	});
});
