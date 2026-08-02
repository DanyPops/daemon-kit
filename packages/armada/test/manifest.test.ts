import { describe, expect, it } from "bun:test";
import { decodeArmadaManifest, MAX_MANIFEST_BYTES } from "../src/index.js";
import { manifestJson } from "./fixtures.js";

describe("decodeArmadaManifest", () => {
	it("decodes, brands, sorts, hashes, and freezes a valid manifest", () => {
		const outcome = decodeArmadaManifest(
			manifestJson([
				JSON.parse(manifestJson()).vehicles[0],
				{
					...JSON.parse(manifestJson()).vehicles[0],
					name: "lector",
					executable: "C:\\Tools\\lector.exe",
					handlePath: "C:\\Temp\\lector.json",
				},
			]),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.manifest.vehicles.map((item) => String(item.name))).toEqual(["lector", "papyrus"]);
		expect(outcome.manifest.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(outcome.manifest)).toBe(true);
		expect(Object.isFrozen(outcome.manifest.vehicles[0])).toBe(true);
	});

	it.each([
		["oversized", `${" ".repeat(MAX_MANIFEST_BYTES)}xx`, "MANIFEST_TOO_LARGE"],
		["invalid JSON", "{", "MANIFEST_JSON_INVALID"],
		["unknown field", JSON.stringify({ schemaVersion: 1, vehicles: [], unknown: true }), "MANIFEST_SCHEMA_INVALID"],
		[
			"relative executable",
			manifestJson([{ ...JSON.parse(manifestJson()).vehicles[0], executable: "bin/papyrus" }]),
			"MANIFEST_PATH_NOT_ABSOLUTE",
		],
		[
			"secret",
			manifestJson([{ ...JSON.parse(manifestJson()).vehicles[0], arguments: ["--token=raw-secret"] }]),
			"MANIFEST_SECRET_MATERIAL",
		],
	])("rejects %s", (_name, text, code) => {
		const outcome = decodeArmadaManifest(text);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.diagnostics.map((item) => item.code)).toContain(code);
	});

	it("rejects duplicate Vehicle names", () => {
		const one = JSON.parse(manifestJson()).vehicles[0];
		const outcome = decodeArmadaManifest(manifestJson([one, one]));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.diagnostics[0]?.code).toBe("MANIFEST_VEHICLE_DUPLICATE");
	});
});
