import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLiveVersionExpectation, readPackageVersion } from "../src/version.ts";

function writeManifest(content: unknown): { url: URL; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "daemon-kit-version-"));
	const path = join(dir, "package.json");
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
	return { url: pathToFileURL(path), dir };
}

describe("readPackageVersion", () => {
	it("reads a valid semver version", () => {
		const { url, dir } = writeManifest({ version: "1.2.3" });
		try {
			expect(readPackageVersion(url, "Acme")).toBe("1.2.3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts a prerelease semver version", () => {
		const { url, dir } = writeManifest({ version: "1.2.3-beta.1" });
		try {
			expect(readPackageVersion(url, "Acme")).toBe("1.2.3-beta.1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws a labeled error for an invalid version string", () => {
		const { url, dir } = writeManifest({ version: "not-a-version" });
		try {
			expect(() => readPackageVersion(url, "Acme")).toThrow("Acme package manifest has an invalid version");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws a labeled error when the manifest is not a JSON object", () => {
		const { url, dir } = writeManifest("[1,2,3]");
		try {
			expect(() => readPackageVersion(url, "Acme")).toThrow("Acme package manifest must be an object");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createLiveVersionExpectation", () => {
	it("re-reads the manifest fresh on every call rather than caching the first read -- the whole point versus a module-level const", () => {
		const { url, dir } = writeManifest({ version: "1.0.0" });
		try {
			const expectedVersion = createLiveVersionExpectation(url, "Acme");
			expect(expectedVersion()).toBe("1.0.0");

			// Simulates `npm update` rewriting package.json underneath an already-running process.
			writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));
			expect(expectedVersion()).toBe("2.0.0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
