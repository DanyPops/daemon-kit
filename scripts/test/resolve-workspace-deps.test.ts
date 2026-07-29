import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "resolve-workspace-deps.mjs");

let workDir: string | undefined;

afterEach(() => {
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	workDir = undefined;
});

function run(targetDir: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("node", [SCRIPT, targetDir], { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("resolve-workspace-deps", () => {
	it("rewrites every workspace:* range to the sibling package's real current ^version", () => {
		workDir = mkdtempSync(join(tmpdir(), "resolve-workspace-deps-"));
		writeFileSync(
			join(workDir, "package.json"),
			JSON.stringify({
				name: "@danypops/example",
				version: "1.0.0",
				dependencies: { "@danypops/vehicle-core": "workspace:*", pino: "^10.3.1" },
				devDependencies: { "@danypops/vehicle-server": "workspace:*" },
			}),
		);

		const result = run(workDir);

		expect(result.status).toBe(0);
		const rewritten = JSON.parse(readFileSync(join(workDir, "package.json"), "utf8"));
		expect(rewritten.dependencies["@danypops/vehicle-core"]).toMatch(/^\^\d+\.\d+\.\d+$/);
		expect(rewritten.dependencies.pino).toBe("^10.3.1");
		expect(rewritten.devDependencies["@danypops/vehicle-server"]).toMatch(/^\^\d+\.\d+\.\d+$/);
	});

	it("is a no-op (exit 0, unchanged file) when there is no workspace:* range at all", () => {
		workDir = mkdtempSync(join(tmpdir(), "resolve-workspace-deps-"));
		const original = { name: "@danypops/example", version: "1.0.0", dependencies: { pino: "^10.3.1" } };
		writeFileSync(join(workDir, "package.json"), JSON.stringify(original));

		const result = run(workDir);

		expect(result.status).toBe(0);
		expect(JSON.parse(readFileSync(join(workDir, "package.json"), "utf8"))).toEqual(original);
	});

	it("refuses a workspace:* dependency outside this repo's own @danypops scope, rather than guessing", () => {
		workDir = mkdtempSync(join(tmpdir(), "resolve-workspace-deps-"));
		writeFileSync(
			join(workDir, "package.json"),
			JSON.stringify({ name: "@danypops/example", version: "1.0.0", dependencies: { "@someone-else/thing": "workspace:*" } }),
		);

		const result = run(workDir);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("not under @danypops/");
	});

	it("requires a target directory argument", () => {
		const result = run("");
		expect(result.status).not.toBe(0);
	});
});
