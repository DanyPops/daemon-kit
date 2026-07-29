import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyLoadableUnderPi } from "@danypops/vehicle-client-pi/pi-load-harness";

const ROOT = resolve(import.meta.dir, "..");
const SRC = (name: string) => resolve(import.meta.dir, "..", "src", name);

function expectAllPathsOk(results: Awaited<ReturnType<typeof verifyLoadableUnderPi>>): void {
	for (const result of results) {
		expect(result.ok, `${result.path} failed: ${result.error ?? "(no error message)"}`).toBe(true);
	}
}

// rpc-client.ts and daemon-client.ts are the two modules a real Pi
// extension imports directly (see e.g. web-spider's/papyrus's own
// pi-extension daemon-client.ts) -- both must stay loadable through every
// path Pi's own extension loader can take.
describe("vehicle-client (the Pi-extension-facing connection seam)", () => {
	beforeAll(() => {
		const result = spawnSync("bun", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
		if (result.status !== 0) throw new Error("bun run build failed -- see output above");
	});

	it("rpc-client.ts loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("rpc-client.ts")));
	});

	it("source (src/daemon-client.ts) loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(SRC("daemon-client.ts")));
	});

	it("the compiled artifact (dist/daemon-client.js) loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "daemon-client.js")));
	});

	it("the compiled artifact (dist/unix-rpc-client.js) loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(resolve(ROOT, "dist", "unix-rpc-client.js")));
	});
});
