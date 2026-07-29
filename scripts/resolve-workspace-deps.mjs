#!/usr/bin/env node
/**
 * Rewrites a package's own "workspace:*" dependency/devDependency/
 * peerDependency ranges to the sibling package's real current version
 * before `npm publish` -- npm's own CLI does not understand Bun's
 * workspace protocol and ships it through to the published tarball
 * verbatim. Confirmed live: @danypops/vehicle-server@0.1.0,
 * @danypops/vehicle-client@0.1.0, and @danypops/vehicle-conformance@0.1.0
 * were all published with a literal, unresolvable "workspace:*" dependency
 * on their sibling packages -- genuinely broken for every real npm
 * consumer, not just a local workspace build.
 *
 * Mutates the target package's package.json in place; run this as the last
 * step before `npm publish` in CI, on a checkout that's discarded
 * afterward, never against a working tree meant to be committed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@danypops/";
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];

const targetDir = process.argv[2];
if (!targetDir) {
	console.error("usage: resolve-workspace-deps.mjs <package-directory>");
	process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repoRoot, "packages");

function realVersionOf(scopedName) {
	const dirName = scopedName.slice(SCOPE.length);
	const manifestPath = join(packagesRoot, dirName, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (typeof manifest.version !== "string" || !manifest.version) {
		throw new Error(`${scopedName}'s own package.json at ${manifestPath} has no version to resolve workspace:* against`);
	}
	return manifest.version;
}

const targetManifestPath = resolve(targetDir, "package.json");
const manifest = JSON.parse(readFileSync(targetManifestPath, "utf8"));

let rewritten = 0;
for (const field of DEP_FIELDS) {
	const deps = manifest[field];
	if (!deps) continue;
	for (const [name, range] of Object.entries(deps)) {
		if (range !== "workspace:*") continue;
		if (!name.startsWith(SCOPE)) throw new Error(`workspace:* dependency "${name}" is not under ${SCOPE} -- resolveWorkspaceDeps only knows this repo's own packages`);
		deps[name] = `^${realVersionOf(name)}`;
		rewritten++;
	}
}

if (rewritten === 0) {
	console.log(`resolve-workspace-deps: no workspace:* ranges found in ${targetManifestPath}`);
	process.exit(0);
}

writeFileSync(targetManifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`resolve-workspace-deps: rewrote ${rewritten} workspace:* range(s) in ${targetManifestPath}`);
