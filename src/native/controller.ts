import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { diagnostic, type Diagnostic } from "../fleet/diagnostic.js";
import type { NativeServiceIdentity } from "../fleet/identity.js";
import type { VehicleSpec } from "../fleet/manifest.js";
import { replaceFileAtomically } from "./atomic-file.js";
import { launchdStrategy } from "./launchd.js";
import type {
	NativeManagerKind,
	NativeOperationOutcome,
	NativeServiceController,
	NativeServiceDescriptor,
	NativeServiceState,
	NativeServiceStrategy,
} from "./service-manager.js";
import { systemdStrategy } from "./systemd.js";
import { windowsTaskSchedulerStrategy } from "./windows-task-scheduler.js";

const MAX_COMMAND_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export type CommandOutcome =
	| { readonly ok: true; readonly stdout: string; readonly stderr: string }
	| { readonly ok: false; readonly stdout: string; readonly stderr: string; readonly code?: number };

export interface CommandRunner {
	run(command: string, arguments_: readonly string[]): Promise<CommandOutcome>;
}

export interface NativeControllerOptions {
	readonly kind: NativeManagerKind;
	readonly descriptorRoot: string;
	readonly commandRunner?: CommandRunner;
	readonly userId?: number;
}

export const processCommandRunner: CommandRunner = {
	run(command, arguments_) {
		return new Promise((resolve) => {
			execFile(command, [...arguments_], { encoding: "utf8", maxBuffer: MAX_COMMAND_BYTES, timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
				if (!error) {
					resolve({ ok: true, stdout, stderr });
					return;
				}
				const code = (error as { code?: string | number }).code;
				resolve({ ok: false, stdout, stderr, ...(typeof code === "number" ? { code } : {}) });
			});
		});
	},
};

export function strategyForNativeManager(kind: NativeManagerKind): NativeServiceStrategy {
	switch (kind) {
		case "systemd":
			return systemdStrategy;
		case "launchd":
			return launchdStrategy;
		case "windows-task-scheduler":
			return windowsTaskSchedulerStrategy;
		default: {
			const exhaustive: never = kind;
			return exhaustive;
		}
	}
}

function commandFailure(command: string, outcome: Extract<CommandOutcome, { ok: false }>): NativeOperationOutcome {
	return {
		ok: false,
		diagnostics: [diagnostic("NATIVE_COMMAND_FAILED", "error", command, outcome.stderr || outcome.stdout || "native command failed")],
	};
}

function descriptorPath(root: string, descriptor: NativeServiceDescriptor): string {
	return join(root, descriptor.fileName);
}

async function readSpecHash(path: string): Promise<string | undefined> {
	try {
		const content = await readFile(path, "utf8");
		return /Armada(?: spec hash: |-SpecHash=)([a-f0-9]{64})/i.exec(content)?.[1];
	} catch {
		return undefined;
	}
}

function parseProperties(stdout: string): ReadonlyMap<string, string> {
	return new Map(
		stdout
			.split(/\r?\n/)
			.map((line) => line.split("=", 2))
			.filter((parts): parts is [string, string] => parts.length === 2),
	);
}

function parseState(kind: NativeManagerKind, stdout: string): Pick<NativeServiceState, "status" | "pid"> {
	if (kind === "systemd") {
		const properties = parseProperties(stdout);
		if (properties.get("LoadState") === "not-found") return { status: "absent" };
		const pid = Number(properties.get("MainPID"));
		const status = properties.get("ActiveState") === "active" ? "running" : properties.get("ActiveState") === "failed" ? "failed" : "stopped";
		return Number.isInteger(pid) && pid > 0 ? { status, pid } : { status };
	}
	const pidMatch = /\bpid\s*[=:]\s*(\d+)/i.exec(stdout);
	const running = kind === "launchd" ? /\bstate\s*=\s*running\b/i.test(stdout) : /\bStatus:\s*Running\b/i.test(stdout);
	const pid = pidMatch ? Number(pidMatch[1]) : undefined;
	return pid !== undefined && Number.isInteger(pid) ? { status: running ? "running" : "stopped", pid } : { status: running ? "running" : "stopped" };
}

function inspectArguments(kind: NativeManagerKind, identity: string, userId: number): readonly string[] {
	if (kind === "systemd") return ["--user", "show", identity, "--property=LoadState", "--property=ActiveState", "--property=MainPID", "--no-pager"];
	if (kind === "launchd") return ["print", `gui/${userId}/${identity}`];
	return ["/Query", "/TN", identity, "/FO", "LIST", "/V"];
}

function executable(kind: NativeManagerKind): string {
	if (kind === "systemd") return "systemctl";
	if (kind === "launchd") return "launchctl";
	return "schtasks";
}

function lifecycleArguments(kind: NativeManagerKind, operation: "start" | "stop", identity: string, path: string, userId: number): readonly string[] {
	if (kind === "systemd") return ["--user", operation, identity];
	if (kind === "launchd") return operation === "start" ? ["bootstrap", `gui/${userId}`, path] : ["bootout", `gui/${userId}/${identity}`];
	return operation === "start" ? ["/Run", "/TN", identity] : ["/End", "/TN", identity];
}

export function defaultDescriptorRoot(
	kind: NativeManagerKind,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	if (kind === "launchd") return join(home, "Library", "LaunchAgents");
	if (kind === "windows-task-scheduler") {
		return win32.join(env["APPDATA"] ?? win32.join(home, "AppData", "Roaming"), "Armada", "descriptors");
	}
	return join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "systemd", "user");
}

export function createNativeController(options: NativeControllerOptions): NativeServiceController {
	const runner = options.commandRunner ?? processCommandRunner;
	const strategy = strategyForNativeManager(options.kind);
	const userId = options.userId ?? process.getuid?.() ?? 0;
	const pathForIdentity = (identity: string): string => {
		if (options.kind === "systemd") return join(options.descriptorRoot, identity);
		if (options.kind === "launchd") return join(options.descriptorRoot, `${identity}.plist`);
		return join(options.descriptorRoot, `${identity.split("\\").at(-1) ?? identity}.xml`);
	};
	return {
		kind: options.kind,
		capabilities: strategy.capabilities,
		async inspect(vehicles: readonly VehicleSpec[]) {
			const services: NativeServiceState[] = [];
			const diagnostics: Diagnostic[] = [];
			for (const vehicle of vehicles) {
				const generated = strategy.generateDescriptor(vehicle);
				if (!generated.ok) return generated;
				diagnostics.push(...generated.diagnostics);
				const command = executable(options.kind);
				const result = await runner.run(command, inspectArguments(options.kind, generated.descriptor.identity, userId));
				if (!result.ok) {
					services.push({ name: vehicle.name, status: "absent" });
					continue;
				}
				const state = parseState(options.kind, result.stdout);
				const specHash = await readSpecHash(descriptorPath(options.descriptorRoot, generated.descriptor));
				services.push({ name: vehicle.name, ...state, ...(specHash === undefined ? {} : { specHash }) });
			}
			return { ok: true, services, diagnostics };
		},
		async replaceDescriptorAtomically(descriptor) {
			const path = descriptorPath(options.descriptorRoot, descriptor);
			const written = await replaceFileAtomically(path, descriptor.content);
			if (!written.ok) return written;
			if (options.kind === "launchd") return written;
			const command = executable(options.kind);
			const arguments_ = options.kind === "systemd" ? ["--user", "daemon-reload"] : ["/Create", "/TN", descriptor.identity, "/XML", path, "/F"];
			const result = await runner.run(command, arguments_);
			return result.ok ? written : commandFailure(command, result);
		},
		async start(identity: NativeServiceIdentity) {
			const command = executable(options.kind);
			const result = await runner.run(command, lifecycleArguments(options.kind, "start", identity, pathForIdentity(identity), userId));
			return result.ok ? { ok: true, diagnostics: [] } : commandFailure(command, result);
		},
		async stop(identity: NativeServiceIdentity) {
			const command = executable(options.kind);
			const result = await runner.run(command, lifecycleArguments(options.kind, "stop", identity, pathForIdentity(identity), userId));
			return result.ok ? { ok: true, diagnostics: [] } : commandFailure(command, result);
		},
	};
}
