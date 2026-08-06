/**
 * Projects Vehicle service declarations into Armada's authoritative fleet.
 * Native descriptor generators remain available for inspection during migration,
 * but installation and removal never mutate service-manager state directly.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { VehicleRegistrar, VehicleRegistrationInput } from "@danypops/armada";

export interface ServiceSpec {
	/** Used in filenames/labels, e.g. "web-spider". Must be filesystem/registry-value-name safe. */
	name: string;
	/** Human display name, e.g. "Web Spider". Defaults to `name`. */
	displayName?: string;
	/** Installed package or daemon version projected into Armada desired state. */
	version: string;
	/** Absolute path to the daemon's entry point (e.g. a `#!/usr/bin/env bun` cli.ts). */
	binPath: string;
	args?: string[];
	env?: Record<string, string>;
	/** Absolute Vehicle handle path used for bounded readiness checks. */
	handlePath: string;
	workingDirectory?: string;
	/** Requests Armada-managed on-failure restart. */
	restartOnFailure?: boolean;
	/** Restart delay in seconds, applied with restartOnFailure. */
	restartSec?: number;
	/** Legacy systemd renderer option; Armada installation rejects it rather than ignoring it. */
	noNewPrivileges?: boolean;
	/** Legacy systemd renderer option; Armada installation rejects it rather than ignoring it. */
	privateTmp?: boolean;
	/** Legacy systemd renderer option; Armada installation rejects it rather than ignoring it. */
	waitForNetwork?: boolean;
}

export interface RunResult {
	ok: boolean;
	output: string;
}

export interface ServiceInstallDeps {
	/** Runs a command to completion. Never throws -- failures are reported via `ok: false`. */
	runCommand: (command: string, args: string[], input?: string) => RunResult;
	/** Resolved published Armada CLI entrypoint. */
	armadaCliPath: string;
}

export type ServiceInstallResult = { installed: true } | { installed: false; reason: string };

const LINUX_INIT_SYSTEM_BINARIES: Record<string, string> = {
	systemctl: "systemd",
	"rc-update": "openrc",
	"update-rc.d": "upstart",
	chkconfig: "systemv",
};

/** Binary-presence detection (not process.platform alone) -- correctly distinguishes systemd from openrc/upstart/systemv Linux hosts. */
export function detectLinuxInitSystem(which: (binary: string) => boolean): string | null {
	for (const binary of Object.keys(LINUX_INIT_SYSTEM_BINARIES)) {
		if (which(binary)) return LINUX_INIT_SYSTEM_BINARIES[binary]!;
	}
	return null;
}

function shellQuote(value: string): string {
	return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

// Same literal string independently declared in daemon.ts and pi-client.ts
// -- lets startDaemon() pick "always-on" (no idle shutdown) for a
// service-launched daemon versus a bounded default for a lazily
// auto-spawned one. Not imported across those modules: pi-client.ts is
// compiled standalone with no imports of its own by design.
const LAUNCH_PROVENANCE_ENV_VAR = "DAEMON_KIT_LAUNCH_PROVENANCE";

function withServiceProvenance(env: Record<string, string> | undefined): Record<string, string> {
	return { [LAUNCH_PROVENANCE_ENV_VAR]: "service", ...env };
}

/** Pure text generator -- a systemd --user unit that starts on login and stays a plain one-shot start, no Restart= (see the module doc comment for why). */
export function generateSystemdUnit(spec: ServiceSpec): string {
	const execLine = [spec.binPath, ...(spec.args ?? [])].map(shellQuote).join(" ");
	// Quoted the same way as ExecStart's own arguments -- an unquoted value containing a space
	// or a literal quote/backslash would otherwise either break systemd's own parsing or, worse,
	// silently truncate at the first space.
	const envLines = Object.entries(withServiceProvenance(spec.env))
		.map(([key, value]) => `Environment=${shellQuote(`${key}=${value}`)}`)
		.join("\n");
	return [
		"[Unit]",
		`Description=${spec.displayName ?? spec.name}`,
		spec.waitForNetwork ? "After=default.target network-online.target" : "After=default.target",
		...(spec.waitForNetwork ? ["Wants=network-online.target"] : []),
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${execLine}`,
		...(envLines ? [envLines] : []),
		...(spec.restartOnFailure ? ["Restart=always"] : []),
		...(spec.restartOnFailure && spec.restartSec !== undefined ? [`RestartSec=${spec.restartSec}`] : []),
		...(spec.noNewPrivileges ? ["NoNewPrivileges=true"] : []),
		...(spec.privateTmp ? ["PrivateTmp=true"] : []),
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/** Pure text generator -- a user-scoped launchd agent plist with RunAtLoad, no KeepAlive (see the module doc comment for why). */
export function generateLaunchdPlist(spec: ServiceSpec): string {
	const label = `com.danypops.${spec.name}`;
	const programArguments = [spec.binPath, ...(spec.args ?? [])].map((value) => `\t\t<string>${escapeXml(value)}</string>`).join("\n");
	const envEntries = Object.entries(withServiceProvenance(spec.env));
	const envBlock = envEntries.length
		? [
				"\t<key>EnvironmentVariables</key>",
				"\t<dict>",
				...envEntries.map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t<string>${escapeXml(value)}</string>`),
				"\t</dict>",
			].join("\n")
		: "";
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${escapeXml(label)}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		programArguments,
		"\t</array>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		...(envBlock ? [envBlock] : []),
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The exact command line stored in the Windows Run registry value.
 *
 * Known gap: a Run key value is a plain command line with no mechanism to
 * set environment variables for the process it launches, unlike systemd's
 * `Environment=` or launchd's `EnvironmentVariables` dict -- so a
 * Windows-service-installed daemon does not receive
 * DAEMON_KIT_LAUNCH_PROVENANCE="service" the way Linux/macOS ones do. It
 * reports "unknown" instead, which resolveIdleBudgetMs() (daemon.ts)
 * already treats the same as "auto-spawn": a bounded idle-shutdown budget
 * rather than always-on. In practice this is not a correctness gap --
 * connectWithPolicy's auto-spawn resurrects the daemon on the next tool
 * call regardless of platform -- just a real, documented asymmetry: a
 * Windows service-installed daemon self-terminates and restarts on demand
 * rather than staying warm indefinitely the way Linux/macOS ones do.
 */
export function windowsRunCommand(spec: ServiceSpec): string {
	return [spec.binPath, ...(spec.args ?? [])].map((value) => `"${value}"`).join(" ");
}

function toVehicleRegistrationInput(spec: ServiceSpec): VehicleRegistrationInput {
	return {
		name: spec.name,
		version: spec.version,
		executable: spec.binPath,
		arguments: spec.args ?? [],
		...(spec.workingDirectory === undefined ? {} : { workingDirectory: spec.workingDirectory }),
		handlePath: spec.handlePath,
		restart: spec.restartOnFailure
			? {
					policy: "on-failure",
					delayMs: Math.max(100, (spec.restartSec ?? 1) * 1_000),
					maxAttempts: 10,
					windowMs: 60_000,
				}
			: { policy: "never" },
		readiness: { timeoutMs: 10_000, pollIntervalMs: 100 },
	};
}

function armadaVehicle(spec: ServiceSpec): string {
	return JSON.stringify(toVehicleRegistrationInput(spec));
}

function armadaValidationFailure(spec: ServiceSpec): ServiceInstallResult | undefined {
	if (spec.env && Object.keys(spec.env).length > 0) {
		return { installed: false, reason: "Armada service declarations cannot contain environment or credential material" };
	}
	if (spec.noNewPrivileges || spec.privateTmp || spec.waitForNetwork) {
		return { installed: false, reason: "legacy systemd-only service controls cannot be projected into Armada" };
	}
	return undefined;
}

/**
 * In-process counterpart to installUserService() -- calls Armada's own
 * VehicleRegistrar library directly (see @danypops/armada's registrar.ts)
 * instead of shelling out to its CLI as a subprocess. Same validation and
 * Vehicle-spec projection as the CLI-backed path below; async because
 * Armada's manifest I/O and native reconciliation are. Introduced for
 * Packed's own daemon-service registration (async end-to-end already, from
 * its HTTP handlers down) without changing the synchronous CLI-subprocess
 * contract every other Vehicle-backed daemon's own `service install`
 * command (web-spider, papyrus, jittor, pipes, lector) already depends on.
 */
export async function registerVehicleService(spec: ServiceSpec, registrar: VehicleRegistrar): Promise<ServiceInstallResult> {
	const invalid = armadaValidationFailure(spec);
	if (invalid) return invalid;
	const outcome = await registrar.register(toVehicleRegistrationInput(spec));
	if (outcome.ok) return { installed: true };
	return { installed: false, reason: outcome.diagnostics.map((item) => item.message).join("; ") || "Armada registration failed" };
}

/** In-process counterpart to uninstallUserService() -- see registerVehicleService()'s own doc comment. */
export async function unregisterVehicleService(name: string, registrar: VehicleRegistrar): Promise<ServiceInstallResult> {
	const outcome = await registrar.unregister(name);
	if (outcome.ok) return { installed: true };
	return { installed: false, reason: outcome.diagnostics.map((item) => item.message).join("; ") || "Armada removal failed" };
}

/** In-process counterpart to isServiceInstalled() -- see registerVehicleService()'s own doc comment. */
export function isVehicleServiceRegistered(name: string, registrar: VehicleRegistrar): Promise<boolean> {
	return registrar.isRegistered(name);
}

/** Delegates desired-state mutation and native reconciliation to Armada. */
export function installUserService(spec: ServiceSpec, deps: ServiceInstallDeps): ServiceInstallResult {
	const invalid = armadaValidationFailure(spec);
	if (invalid) return invalid;
	const upsert = deps.runCommand(process.execPath, [deps.armadaCliPath, "upsert", "--vehicle-file", "-", "--json"], armadaVehicle(spec));
	if (!upsert.ok) return { installed: false, reason: `armada upsert failed: ${upsert.output}` };
	const reconcile = deps.runCommand(process.execPath, [deps.armadaCliPath, "reconcile", "--json"]);
	if (!reconcile.ok) return { installed: false, reason: `armada reconcile failed: ${reconcile.output}` };
	return { installed: true };
}

export function uninstallUserService(name: string, deps: ServiceInstallDeps): ServiceInstallResult {
	const result = deps.runCommand(process.execPath, [deps.armadaCliPath, "remove", name, "--json"]);
	if (!result.ok) return { installed: false, reason: `armada remove failed: ${result.output}` };
	return { installed: true };
}

/** Whether Armada reports this Vehicle in its desired fleet. */
export function isServiceInstalled(name: string, deps: ServiceInstallDeps): boolean {
	const result = deps.runCommand(process.execPath, [deps.armadaCliPath, "status", "--json"]);
	if (!result.ok) return false;
	try {
		const status = JSON.parse(result.output) as { vehicles?: Array<{ name?: string }> };
		return status.vehicles?.some((vehicle) => vehicle.name === name) ?? false;
	} catch {
		return false;
	}
}

/** Real Armada CLI dependencies against the actual shell. */
export function createNodeServiceInstallDeps(): ServiceInstallDeps {
	return {
		armadaCliPath: fileURLToPath(import.meta.resolve("@danypops/armada/cli")),
		runCommand: (command, args, input): RunResult => {
			try {
				const output = execFileSync(command, args, {
					encoding: "utf8",
					input,
					stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
				});
				return { ok: true, output };
			} catch (error) {
				const execError = error as { stdout?: string; stderr?: string; message: string };
				return { ok: false, output: (execError.stdout ?? "") + (execError.stderr ?? execError.message) };
			}
		},
	};
}

export type ServiceAction = "start" | "stop" | "restart" | "status";

/** The real unit name Armada generates for a vehicle -- see armada's native/systemd.ts. */
export function armadaUnitName(vehicleName: string): string {
	return `armada-${vehicleName}.service`;
}

export interface ServiceCli {
	unitName: string;
	install: () => ServiceInstallResult;
	uninstall: () => ServiceInstallResult;
	action: (action: ServiceAction) => void;
}

export interface ServiceCliDeps extends ServiceInstallDeps {
	/** Defaults to a real `systemctl --user <action> <unitName>` shell-out. */
	runSystemctl?: (action: ServiceAction, unitName: string) => void;
}

const defaultRunSystemctl = (action: ServiceAction, unitName: string): void => {
	execFileSync("systemctl", ["--user", action, unitName], { stdio: "inherit" });
};

/**
 * Every Vehicle-backed daemon's own CLI (web-spider, papyrus, jittor, pipes,
 * lector, tickets, ...) otherwise hand-rolls its own install()/systemctl()
 * wrapper and re-derives the Armada unit name itself -- this is the one
 * place that logic lives, so a `service install/start/stop/restart/status`
 * command becomes a thin wrapper around one createServiceCli(spec) call.
 */
export function createServiceCli(spec: ServiceSpec, deps: ServiceCliDeps = createNodeServiceInstallDeps()): ServiceCli {
	const unitName = armadaUnitName(spec.name);
	const runSystemctl = deps.runSystemctl ?? defaultRunSystemctl;
	return {
		unitName,
		install: () => installUserService(spec, deps),
		uninstall: () => uninstallUserService(spec.name, deps),
		action: (action) => runSystemctl(action, unitName),
	};
}
