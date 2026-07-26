import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyLoadableUnderPi } from "../src/pi-load-harness.ts";

const ROOT = resolve(import.meta.dir, "..");

const SRC = (name: string) => resolve(import.meta.dir, "..", "src", name);

function expectAllPathsOk(results: Awaited<ReturnType<typeof verifyLoadableUnderPi>>): void {
	for (const result of results) {
		expect(result.ok, `${result.path} failed: ${result.error ?? "(no error message)"}`).toBe(true);
	}
}

describe("verifyLoadableUnderPi", () => {
	it("reports one result per load path, in a stable order", async () => {
		const results = await verifyLoadableUnderPi(SRC("rpc-client.ts"));
		expect(results.map((r) => r.path)).toEqual(["native-esm", "jiti-try-native-false", "jiti-try-native-true"]);
	});

	it("a genuinely broken module fails every path with a real error, not a silent pass", async () => {
		const results = await verifyLoadableUnderPi(resolve(import.meta.dir, "fixtures", "broken-module.ts"));
		for (const result of results) {
			expect(result.ok).toBe(false);
			expect(result.error).toBeTruthy();
		}
	});

	// rpc-client.ts (fetch/Request only) is the module this house's Pi
	// extensions actually need loadable today -- every retrying-client
	// reimplementation this task exists to replace wraps exactly this class.
	it("rpc-client.ts loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("rpc-client.ts")));
	});

	it("paths.ts loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("paths.ts")));
	});

	it("version.ts loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("version.ts")));
	});

	// storage.ts imports bun:sqlite as a type only (erased at compile time)
	// and resolves the real constructor lazily behind an isBun check, so
	// *loading* it does not require a Bun runtime -- only *calling*
	// openSqliteWithPragmas() under Node would hit node:sqlite instead.
	// Recorded here as a real, checked finding rather than an assumption:
	// daemon-kit's raw TypeScript is not uniformly unsafe under jiti, but the
	// pi-client seam is still shipped pre-compiled (see pi-client.ts) because
	// this result is a property of today's source, not a guarantee jiti
	// itself makes.
	it("storage.ts loads under every Pi extension load path (module load only, not bun:sqlite execution)", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("storage.ts")));
	});

	// daemon.ts calls Bun.serve() inside startDaemon()/runDaemonProcess(),
	// never at module top level, so importing it alone never reaches that
	// call.
	it("daemon.ts loads under every Pi extension load path (Bun.serve is deferred to a function call)", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("daemon.ts")));
	});

	// pi-client.ts is the one module this package ships pre-compiled
	// specifically for Pi extension consumption -- rebuild it fresh here
	// (rather than trusting a stale dist/ from a previous run) and prove the
	// actual published artifact loads under every path, not just its source.
	describe("pi-client (the pre-compiled Pi extension seam)", () => {
		beforeAll(() => {
			const result = spawnSync("bun", ["run", "build:pi-client"], { cwd: ROOT, stdio: "inherit" });
			if (result.status !== 0) throw new Error("bun run build:pi-client failed -- see output above");
		});

		it("source (src/pi-client.ts) loads under every Pi extension load path", async () => {
			expectAllPathsOk(await verifyLoadableUnderPi(SRC("pi-client.ts")));
		});

		it("the compiled artifact (dist/pi-client.js) loads under every Pi extension load path", async () => {
			expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "pi-client.js")));
		});
	});
});
