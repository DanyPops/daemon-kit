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
		const results = await verifyLoadableUnderPi(SRC("secrets-backend.ts"));
		expect(results.map((r) => r.path)).toEqual(["native-esm", "jiti-try-native-false", "jiti-try-native-true"]);
	});

	it("a genuinely broken module fails every path with a real error, not a silent pass", async () => {
		const results = await verifyLoadableUnderPi(resolve(import.meta.dir, "fixtures", "broken-module.ts"));
		for (const result of results) {
			expect(result.ok).toBe(false);
			expect(result.error).toBeTruthy();
		}
	});
});

// vehicle-client-pi is the one Vehicle package Pi actually loads as an
// extension dependency -- its published artifact must remain loadable
// through every Pi extension load path.
describe("vehicle-client-pi (the pre-compiled Pi host projection)", () => {
	// A real tsc build subprocess (~3s locally) sits close to bun test's
	// default 5000ms hook timeout, tipping over intermittently on a loaded
	// CI runner. Give it real headroom instead of racing the default.
	beforeAll(() => {
		const result = spawnSync("bun", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
		if (result.status !== 0) throw new Error("bun run build failed -- see output above");
	}, 30_000);

	it("source (src/vehicle-pi.ts) loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("vehicle-pi.ts")));
	});

	it("the compiled artifact (dist/vehicle-pi.js) loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "vehicle-pi.js")));
	});

	it("secrets-tui.ts loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("secrets-tui.ts")));
	});
});
