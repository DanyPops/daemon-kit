/**
 * Spawns a real fixture subprocess via the actual spawnUnit function —
 * env injection needs to be observed reaching a real child process, not
 * asserted against a reimplementation. spawnUnit inherits stdio (matching
 * a real supervised daemon whose logs should flow to the supervisor's own
 * log stream), so the fixture writes its observed value to a file instead
 * of stdout, which the test then reads back.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnUnit, type DaemonUnit } from "../src/supervisor.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "echo-env-unit.ts");

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "daemon-kit-supervisor-"));
}

describe("spawnUnit", () => {
	it("injects credential env vars into the real spawned child process", async () => {
		const dir = tmpDir();
		try {
			const outPath = join(dir, "out.txt");
			const unit: DaemonUnit = { name: "probe", bin: "bun", args: [FIXTURE, outPath], backends: ["github"] };
			const spawned = spawnUnit(unit, { PROBE_VALUE: "injected-secret" });

			expect(spawned.name).toBe("probe");
			expect(typeof spawned.pid).toBe("number");
			expect(await spawned.exited).toBe(0);
			expect(readFileSync(outPath, "utf8")).toBe("injected-secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets injected credential env win over a unit's own static env on a name collision", async () => {
		const dir = tmpDir();
		try {
			const outPath = join(dir, "out.txt");
			const unit: DaemonUnit = {
				name: "probe",
				bin: "bun",
				args: [FIXTURE, outPath],
				backends: ["github"],
				env: { PROBE_VALUE: "stale-static-value" },
			};
			const spawned = spawnUnit(unit, { PROBE_VALUE: "fresh-cred-value" });
			expect(await spawned.exited).toBe(0);
			expect(readFileSync(outPath, "utf8")).toBe("fresh-cred-value");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still runs correctly with no credential env at all (a unit with zero required backends)", async () => {
		const dir = tmpDir();
		try {
			const outPath = join(dir, "out.txt");
			const unit: DaemonUnit = { name: "probe", bin: "bun", args: [FIXTURE, outPath], backends: [] };
			const spawned = spawnUnit(unit);
			expect(await spawned.exited).toBe(0);
			expect(readFileSync(outPath, "utf8")).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
