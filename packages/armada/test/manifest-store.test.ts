import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeManifestVehicle, upsertManifestVehicle } from "../src/index.js";
import { manifestJson } from "./fixtures.js";

describe("Armada manifest store", () => {
	it("atomically upserts and removes Vehicles without replacing the fleet", async () => {
		const directory = await mkdtemp(join(tmpdir(), "armada-manifest-"));
		const path = join(directory, "armada.json");
		await writeFile(path, manifestJson());
		const lector = {
			name: "lector",
			version: "1.0.0",
			executable: "/opt/lector/cli.js",
			arguments: ["serve"],
			handlePath: "/run/user/1000/lector/handle.json",
			restart: { policy: "never" },
			readiness: { timeoutMs: 5_000, pollIntervalMs: 100 },
		};
		expect((await upsertManifestVehicle(path, JSON.stringify(lector))).ok).toBe(true);
		expect(JSON.parse(await readFile(path, "utf8")).vehicles.map((item: { name: string }) => item.name)).toEqual(["lector", "papyrus"]);
		expect((await removeManifestVehicle(path, "papyrus")).ok).toBe(true);
		expect(JSON.parse(await readFile(path, "utf8")).vehicles.map((item: { name: string }) => item.name)).toEqual(["lector"]);
	});

	it("rejects malformed Vehicle input without changing the manifest", async () => {
		const directory = await mkdtemp(join(tmpdir(), "armada-manifest-"));
		const path = join(directory, "armada.json");
		const original = manifestJson();
		await writeFile(path, original);
		const outcome = await upsertManifestVehicle(path, JSON.stringify({ name: "bad" }));
		expect(outcome).toMatchObject({ ok: false, diagnostics: [{ code: "MANIFEST_SCHEMA_INVALID" }] });
		expect(await readFile(path, "utf8")).toBe(original);
	});
});
