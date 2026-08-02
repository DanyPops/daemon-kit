import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { createMemoryFile, registerMemoryOperations } from "../src/extension.ts";

const dirs: string[] = [];
function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "vehicle-memory-template-"));
	dirs.push(dir);
	return join(dir, "memory.json");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory template", () => {
	it("createMemoryFile round-trips a fact through a real file on disk", async () => {
		const filePath = tempFile();
		const memory = createMemoryFile(filePath);
		await memory.remember("favorite-color", "blue");
		expect(await memory.recall("favorite-color")).toBe("blue");

		// A fresh instance re-reading the same file sees the same fact --
		// proves it's real durable storage, not just an in-memory cache.
		const reopened = createMemoryFile(filePath);
		expect(await reopened.recall("favorite-color")).toBe("blue");
	});

	it("recalling a never-remembered key returns undefined, not an error", async () => {
		const memory = createMemoryFile(tempFile());
		expect(await memory.recall("nothing-here")).toBeUndefined();
	});

	it("registers memory.remember and memory.recall as real Vehicle operations", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.0.0", description: "test" });
		registerMemoryOperations(registry, tempFile());
		const names = registry.manifest().operations.map((op) => op.name).sort();
		expect(names).toEqual(["memory.recall", "memory.remember"]);
	});

	it("memory.remember then memory.recall round-trip through the real registry", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.0.0", description: "test" });
		registerMemoryOperations(registry, tempFile());

		await registry.invoke("memory.remember", 1, { key: "project-name", text: "vehicle" });
		const recalled = (await registry.invoke("memory.recall", 1, { key: "project-name" })) as { found: boolean; text?: string };
		expect(recalled).toEqual({ found: true, text: "vehicle" });
	});

	it("memory.recall reports found:false for an unknown key instead of throwing", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.0.0", description: "test" });
		registerMemoryOperations(registry, tempFile());

		const recalled = await registry.invoke("memory.recall", 1, { key: "unknown" });
		expect(recalled).toEqual({ found: false });
	});
});
