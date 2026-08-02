#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnostic, type Diagnostic } from "./fleet/diagnostic.js";
import { decodeArmadaManifest, MAX_MANIFEST_BYTES, type ManifestDecodeOutcome } from "./fleet/manifest.js";
import { planFleet } from "./fleet/planner.js";
import type { NativeManagerKind, NativeServiceManager } from "./native/service-manager.js";

export interface CliIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

export interface CliDependencies {
	readonly manager: NativeServiceManager;
	readonly io: CliIo;
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

interface PlanArguments {
	readonly manifestPath: string;
	readonly json: boolean;
}

type ArgumentOutcome = { readonly ok: true; readonly arguments: PlanArguments } | { readonly ok: false; readonly diagnostic: Diagnostic };

export function defaultManifestPath(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	if (platform === "darwin") return join(home, "Library", "Application Support", "armada", "armada.json");
	if (platform === "win32") return win32.join(env["APPDATA"] ?? win32.join(home, "AppData", "Roaming"), "Armada", "armada.json");
	return join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "armada", "armada.json");
}

function parsePlanArguments(args: readonly string[], dependencies: CliDependencies): ArgumentOutcome {
	let manifestPath = defaultManifestPath(dependencies.platform, dependencies.env, dependencies.home);
	let json = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--manifest") {
			const value = args[index + 1];
			if (!value) return { ok: false, diagnostic: diagnostic("CLI_ARGUMENT_MISSING", "error", "--manifest", "path is required") };
			manifestPath = value;
			index++;
			continue;
		}
		return { ok: false, diagnostic: diagnostic("CLI_ARGUMENT_UNKNOWN", "error", argument ?? "", "unknown argument") };
	}
	return { ok: true, arguments: { manifestPath, json } };
}

async function readManifest(path: string): Promise<ManifestDecodeOutcome> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			return { ok: false, diagnostics: [diagnostic("MANIFEST_PATH_UNSAFE", "error", path, "manifest must be a regular file")] };
		}
		if (stat.size > MAX_MANIFEST_BYTES) {
			return { ok: false, diagnostics: [diagnostic("MANIFEST_TOO_LARGE", "error", path, "manifest exceeds 1 MiB")] };
		}
		return decodeArmadaManifest(await readFile(path, "utf8"));
	} catch (error) {
		return {
			ok: false,
			diagnostics: [diagnostic("MANIFEST_READ_FAILED", "error", path, error instanceof Error ? error.message : String(error))],
		};
	}
}

function writeDiagnostics(diagnostics: readonly Diagnostic[], json: boolean, io: CliIo): void {
	if (json) {
		io.stdout(`${JSON.stringify({ ok: false, diagnostics })}\n`);
		return;
	}
	for (const item of diagnostics) io.stderr(`${item.severity.toUpperCase()} ${item.code} ${item.path}: ${item.message}\n`);
}

export async function runCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
	const [command, ...rest] = args;
	if (command !== "plan") {
		writeDiagnostics([diagnostic("CLI_COMMAND_UNKNOWN", "error", command ?? "", "usage: armada plan [--manifest <path>] [--json]")], false, dependencies.io);
		return 2;
	}
	const parsed = parsePlanArguments(rest, dependencies);
	if (!parsed.ok) {
		writeDiagnostics([parsed.diagnostic], false, dependencies.io);
		return 2;
	}
	const decoded = await readManifest(parsed.arguments.manifestPath);
	if (!decoded.ok) {
		writeDiagnostics(decoded.diagnostics, parsed.arguments.json, dependencies.io);
		return 1;
	}
	const inspected = await dependencies.manager.inspect(decoded.manifest.vehicles);
	if (!inspected.ok) {
		writeDiagnostics(inspected.diagnostics, parsed.arguments.json, dependencies.io);
		return 1;
	}
	const planned = planFleet(decoded.manifest, inspected.services);
	if (!planned.ok) {
		writeDiagnostics(planned.diagnostics, parsed.arguments.json, dependencies.io);
		return 1;
	}
	if (parsed.arguments.json) {
		dependencies.io.stdout(`${JSON.stringify({ ok: true, manager: dependencies.manager.kind, ...planned.plan })}\n`);
		return 0;
	}
	dependencies.io.stdout(`plan: ${planned.plan.operations.length} operation(s) via ${dependencies.manager.kind}\n`);
	for (const operation of planned.plan.operations) dependencies.io.stdout(`  ${operation.kind} ${operation.name}\n`);
	return 0;
}

function managerKind(platform: NodeJS.Platform): NativeManagerKind {
	if (platform === "darwin") return "launchd";
	if (platform === "win32") return "windows-task-scheduler";
	return "systemd";
}

function unavailableManager(platform: NodeJS.Platform): NativeServiceManager {
	return {
		kind: managerKind(platform),
		capabilities: { maximumMemoryBytes: false, maximumCpuPercent: false, maximumTasks: false },
		inspect: () =>
			Promise.resolve({
				ok: false,
				diagnostics: [diagnostic("NATIVE_MANAGER_NOT_IMPLEMENTED", "error", "/", "native strategy is not implemented in this walking-skeleton release")],
			}),
	};
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
	process.exitCode = await runCli(process.argv.slice(2), {
		manager: unavailableManager(process.platform),
		io: {
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
		},
	});
}
