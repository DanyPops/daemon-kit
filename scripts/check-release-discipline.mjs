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

const EXPORT_BLOCK_OPEN_PATTERN = /^export\s+(?:interface\s+\w+|type\s+\w+\s*=)\b/;

/**
 * Scoped to an actual exported interface/type-literal body -- an unexported function's own
 * multi-line parameter list (one param per line, e.g. after a Biome reformat) matches the
 * bare `name: Type` shape just as well as a real interface property, with nothing in the
 * original unscoped version to tell them apart. Tracks brace depth across every diff line
 * (context included) and only counts a `${prefix}` line while depth is at or below the level
 * an `export interface`/`export type =` line's own opening brace introduced.
 */
function propertyNames(lines, prefix, requiredOnly) {
	const names = new Set();
	const optional = requiredOnly ? "" : "[?]?";
	const propertyPattern = new RegExp(`^\\s*(?:readonly\\s+)?([A-Za-z_$][\\w$]*)${optional}\\s*:`);
	let depth = 0;
	let exportedAtDepth = null;
	for (const rawLine of lines) {
		const marker = rawLine.length > 0 ? rawLine[0] : " ";
		const content = rawLine.length > 0 ? rawLine.slice(1) : "";
		const opensExportBlock = exportedAtDepth === null && EXPORT_BLOCK_OPEN_PATTERN.test(content) && content.includes("{");
		if (marker === prefix && exportedAtDepth !== null && depth >= exportedAtDepth) {
			const match = content.match(propertyPattern);
			if (match?.[1] && (!requiredOnly || !content.includes(`${match[1]}?`))) names.add(match[1]);
		}
		const opens = (content.match(/\{/g) ?? []).length;
		const closes = (content.match(/\}/g) ?? []).length;
		if (opensExportBlock) exportedAtDepth = depth + 1;
		depth += opens - closes;
		if (exportedAtDepth !== null && depth < exportedAtDepth) exportedAtDepth = null;
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
