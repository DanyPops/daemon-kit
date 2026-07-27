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
	it("daemon.ts loads under every Pi extension load path (binding a real listener, Bun or Node, is deferred to a function call)", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("daemon.ts")));
	});

	// service.ts shells out via an injected runCommand rather than importing
	// node:child_process itself, and has no third-party imports -- checked
	// here for the same defensive-completeness reason as paths.ts/daemon.ts,
	// even though it is a daemon-CLI concern, not a Pi-extension-facing one.
	it("service.ts loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("service.ts")));
	});

	it("push-channel.ts loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("push-channel.ts")));
	});

	// daemon.ts is shipped compiled for a different reason than pi-client/vehicle
	// (a real Node/tsc consumer like Alef, not Pi's jiti loader -- daemon.ts was
	// never meant to run inside a Pi extension) -- checked here anyway since the
	// artifact exists and the check is cheap.
	describe("daemon (the pre-compiled Node/tsc-consumable daemon skeleton)", () => {
		beforeAll(() => {
			const result = spawnSync("bun", ["run", "build:daemon"], { cwd: ROOT, stdio: "inherit" });
			if (result.status !== 0) throw new Error("bun run build:daemon failed -- see output above");
		});

		it("the compiled artifact (dist/daemon.js) loads under every Pi extension load path", async () => {
			expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "daemon.js")));
		});
	});

	// Vehicle is shared by agent hosts and tool providers, so its published
	// artifact must remain loadable through the same Node/jiti paths as pi-client.
	describe("vehicle (the pre-compiled agent-tool runtime)", () => {
		beforeAll(() => {
			const result = spawnSync("bun", ["run", "build:vehicle"], { cwd: ROOT, stdio: "inherit" });
			if (result.status !== 0) throw new Error("bun run build:vehicle failed -- see output above");
		});

		it("source (src/vehicle.ts) loads under every Pi extension load path", async () => {
			expectAllPathsOk(await verifyLoadableUnderPi(SRC("vehicle.ts")));
		});

		it("the compiled artifact (dist/vehicle.js) loads under every Pi extension load path", async () => {
			expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "vehicle.js")));
		});
	});

	// Type-only Pi peers keep the host projection loadable before Pi initializes it.
	describe("vehicle-pi (the pre-compiled Pi host projection)", () => {
		beforeAll(() => {
			const result = spawnSync("bun", ["run", "build:vehicle-pi"], { cwd: ROOT, stdio: "inherit" });
			if (result.status !== 0) throw new Error("bun run build:vehicle-pi failed -- see output above");
		});

		it("source (src/vehicle-pi.ts) loads under every Pi extension load path", async () => {
			expectAllPathsOk(await verifyLoadableUnderPi(SRC("vehicle-pi.ts")));
		});

		it("the compiled artifact (dist/vehicle-pi.js) loads under every Pi extension load path", async () => {
			expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "vehicle-pi.js")));
		});
	});

	// pi-client.ts is pre-compiled specifically for Pi extension consumption;
	// rebuild it fresh here
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
