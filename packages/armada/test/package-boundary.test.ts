import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { runCli } from "@danypops/armada/cli";

describe("published package boundary", () => {
	it("exports the CLI module and ships an executable entry point", async () => {
		expect(runCli).toBeTypeOf("function");
		expect(await readFile(new URL("../dist/cli.js", import.meta.url), "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
	});
});
