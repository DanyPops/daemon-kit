import { beforeAll, describe, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "bun:test";
import { verifyLoadableUnderPi } from "@danypops/daemon-kit/pi-load-harness";

const ROOT = resolve(import.meta.dir, "..");
const SRC = (name: string) => resolve(import.meta.dir, "..", "src", name);

function expectAllPathsOk(results: Awaited<ReturnType<typeof verifyLoadableUnderPi>>): void {
	for (const result of results) {
		expect(result.ok, `${result.path} failed: ${result.error ?? "(no error message)"}`).toBe(true);
	}
}

// vehicle-client-pi is the one Vehicle package Pi actually loads as an
// extension dependency -- its published artifact must remain loadable
// through the same Node/jiti paths as daemon-kit's own pi-client.
describe("vehicle-client-pi (the pre-compiled Pi host projection)", () => {
	beforeAll(() => {
		const result = spawnSync("bun", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
		if (result.status !== 0) throw new Error("bun run build failed -- see output above");
	});

	it("source (src/vehicle-pi.ts) loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("vehicle-pi.ts")));
	});

	it("the compiled artifact (dist/vehicle-pi.js) loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "vehicle-pi.js")));
	});
});
