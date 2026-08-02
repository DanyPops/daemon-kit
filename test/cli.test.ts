import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import type { NativeServiceManager } from "../src/index.js";
import { manifestJson } from "./fixtures.js";

function output(): { io: CliIo; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) }, stdout, stderr };
}

const manager: NativeServiceManager = {
	kind: "systemd",
	capabilities: {
		maximumMemoryBytes: true,
		maximumCpuPercent: true,
		maximumTasks: true,
		restartAlways: true,
		restartOnFailure: true,
		restartAttemptLimit: true,
		restartAttemptWindow: true,
	},
	inspect: () => Promise.resolve({ ok: true, services: [], diagnostics: [] }),
};

describe("armada plan", () => {
	it("runs manifest to plan through the injected native strategy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "armada-cli-"));
		const path = join(directory, "armada.json");
		await writeFile(path, manifestJson());
		const captured = output();
		const code = await runCli(["plan", "--manifest", path, "--json"], { manager, io: captured.io });
		expect(code).toBe(0);
		expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
			ok: true,
			manager: "systemd",
			operations: [{ kind: "install", name: "papyrus" }],
		});
		expect(captured.stderr).toEqual([]);
	});

	it("returns stable machine-readable diagnostics for invalid input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "armada-cli-"));
		const path = join(directory, "armada.json");
		await writeFile(path, "{");
		const captured = output();
		const code = await runCli(["plan", "--manifest", path, "--json"], { manager, io: captured.io });
		expect(code).toBe(1);
		expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ ok: false, diagnostics: [{ code: "MANIFEST_JSON_INVALID" }] });
	});
});
