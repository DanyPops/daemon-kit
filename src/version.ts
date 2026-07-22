/**
 * Runtime package version read from the caller's own package.json — the
 * single release source of truth, never hand-duplicated or hardcoded.
 * Every @danypops daemon had its own byte-identical copy of this function;
 * web-spider-daemon's had drifted into a stale hardcoded "0.1.0" while the
 * package itself had moved to 0.11.0 -- exactly the class of bug a shared
 * implementation removes by construction.
 */
import { readFileSync } from "node:fs";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param packageJsonUrl `new URL("../package.json", import.meta.url)` from
 *   the caller's own version.ts, so resolution is relative to the caller's
 *   file, not daemon-kit's.
 * @param projectLabel used only in error messages, e.g. "Jittor".
 */
export function readPackageVersion(packageJsonUrl: URL, projectLabel: string): string {
	const manifest = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as unknown;
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		throw new Error(`${projectLabel} package manifest must be an object`);
	}
	const version = (manifest as Record<string, unknown>)["version"];
	if (typeof version !== "string" || !SEMVER_RE.test(version)) {
		throw new Error(`${projectLabel} package manifest has an invalid version`);
	}
	return version;
}
