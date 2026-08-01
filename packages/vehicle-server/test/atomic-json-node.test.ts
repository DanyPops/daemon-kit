import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtomicJsonWriter } from "@danypops/vehicle-core";
import { createNodeAtomicJsonFsAdapter } from "../src/atomic-json-node.ts";

describe("createNodeAtomicJsonFsAdapter", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vehicle-atomic-json-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("write() + read() round-trip through the real filesystem", async () => {
		const writer = createAtomicJsonWriter({ fs: createNodeAtomicJsonFsAdapter() });
		const filePath = join(dir, "state.json");
		await writer.write(filePath, { jobs: [{ id: "1", status: "running" }] });

		const raw = await readFile(filePath, "utf8");
		expect(JSON.parse(raw)).toEqual({ jobs: [{ id: "1", status: "running" }] });
		await expect(writer.read(filePath)).resolves.toEqual({ jobs: [{ id: "1", status: "running" }] });
	});

	test("no orphaned temp file is left behind in the real directory after a successful write", async () => {
		const writer = createAtomicJsonWriter({ fs: createNodeAtomicJsonFsAdapter() });
		const filePath = join(dir, "state.json");
		await writer.write(filePath, { ok: true });

		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(dir);
		expect(entries).toEqual(["state.json"]);
	});

	test("read() of a file that was never written returns undefined", async () => {
		const writer = createAtomicJsonWriter({ fs: createNodeAtomicJsonFsAdapter() });
		await expect(writer.read(join(dir, "missing.json"))).resolves.toBeUndefined();
	});
});
