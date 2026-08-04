import { execFileSync } from "node:child_process";

const MAX_GIT_OUTPUT_BYTES = 2_000_000;
const PACKAGES = new Map([
	["vehicle-core", "packages/vehicle-core"],
	["vehicle-server", "packages/vehicle-server"],
]);

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES }).trim();
}

function declarationNames(lines, prefix) {
	const names = new Set();
	const pattern = new RegExp(`^\\${prefix}export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:class|function|interface|type|const|enum)\\s+([A-Za-z_$][\\w$]*)`);
	for (const line of lines) {
		const match = line.match(pattern);
		if (match?.[1]) names.add(match[1]);
	}
	return names;
}

function propertyNames(lines, prefix, requiredOnly) {
	const names = new Set();
	const optional = requiredOnly ? "" : "[?]?";
	const pattern = new RegExp(`^\\${prefix}\\s*(?:readonly\\s+)?([A-Za-z_$][\\w$]*)${optional}\\s*:`);
	for (const line of lines) {
		const match = line.match(pattern);
		if (match?.[1] && (!requiredOnly || !line.includes(`${match[1]}?`))) names.add(match[1]);
	}
	return names;
}

export function findBreakingTypeCandidates(diff) {
	const lines = diff.split("\n").filter((line) => !line.startsWith("---") && !line.startsWith("+++"));
	const removedDeclarations = declarationNames(lines, "-");
	const addedDeclarations = declarationNames(lines, "+");
	const removedProperties = propertyNames(lines, "-", false);
	const addedProperties = propertyNames(lines, "+", false);
	const addedRequiredProperties = propertyNames(lines, "+", true);
	return {
		removedDeclarations: [...removedDeclarations].filter((name) => !addedDeclarations.has(name)),
		removedProperties: [...removedProperties].filter((name) => !addedProperties.has(name)),
		addedRequiredProperties: [...addedRequiredProperties].filter((name) => !removedProperties.has(name)),
	};
}

function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`invalid package version: ${version}`);
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function enforceReleaseDiscipline({ previousVersion, currentVersion, candidates, releaseMessage }) {
	const breaking = Object.values(candidates).some((names) => names.length > 0);
	if (!breaking) return;
	const previous = parseVersion(previousVersion);
	const current = parseVersion(currentVersion);
	if (previous.major > 0 && current.major <= previous.major) {
		throw new Error(`breaking public type candidates require a major version bump after 1.0 (${previousVersion} -> ${currentVersion})`);
	}
	if (previous.major === 0 && !releaseMessage.includes("BREAKING CHANGE:")) {
		throw new Error("pre-1.0 breaking public type candidates require a BREAKING CHANGE: note in the release commit");
	}
}

function main() {
	const tag = process.env.GITHUB_REF_NAME ?? "";
	const entry = [...PACKAGES.entries()].find(([name]) => tag.startsWith(`${name}-v`));
	if (!entry) return;
	const [packageName, packageDirectory] = entry;
	const currentVersion = tag.slice(`${packageName}-v`.length);
	const packageVersion = JSON.parse(git(["show", `HEAD:${packageDirectory}/package.json`])).version;
	if (currentVersion !== packageVersion) throw new Error(`tag ${currentVersion} does not match package version ${packageVersion}`);
	const previousTag = git(["tag", "--sort=-v:refname", "--list", `${packageName}-v*`])
		.split("\n")
		.find((candidate) => candidate && candidate !== tag);
	if (!previousTag) return;
	const previousVersion = previousTag.slice(`${packageName}-v`.length);
	const diff = git(["diff", "--unified=0", `${previousTag}..HEAD`, "--", `${packageDirectory}/src`]);
	const candidates = findBreakingTypeCandidates(diff);
	enforceReleaseDiscipline({ previousVersion, currentVersion, candidates, releaseMessage: git(["log", "-1", "--format=%B"]) });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
