import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { runCli } from "@danypops/armada/cli";
import { createArmadaTestHarness } from "@danypops/armada/testing";

describe("published package boundary", () => {
	it("exports the CLI, testing harness, and executable entry point", async () => {
		expect(runCli).toBeTypeOf("function");
		expect(createArmadaTestHarness).toBeTypeOf("function");
		expect(await readFile(new URL("../dist/cli.js", import.meta.url), "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
	});
});
