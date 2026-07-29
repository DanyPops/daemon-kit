/**
 * Cross-platform login/boot persistence for an auto-spawned daemon --
 * generalizes web-spider-daemon's own bespoke systemd --user unit writer
 * (cli.ts) and adds the macOS and Windows equivalents that never existed
 * anywhere in this house's daemons.
 *
 * Scope is deliberately narrower than a process supervisor: connectWithPolicy's
 * auto-spawn plus startDaemon's single-instance lock (see pi-client.ts and
 * daemon.ts) already resurrect the daemon lazily on the next tool call
 * regardless of what, if anything, supervises it. This module's only job is
 * making sure one gets started once after login/reboot with the right
 * environment -- not restart-on-crash supervision, which would just
 * duplicate what auto-spawn already provides for free on every platform.
 *
 * Linux: a systemd --user unit (no elevation), matching web-spider's
 * existing approach. Init-system detection is by binary presence (pm2's
 * own technique, read directly from its lib/API/Startup.js) rather than
 * assuming systemd from process.platform alone -- an unsupported init
 * system fails with a clear, specific error instead of silently guessing.
 * macOS: a user-scoped ~/Library/LaunchAgents/<label>.plist with
 * RunAtLoad, loaded via `launchctl bootstrap gui/<uid>` -- the
 * headless-daemon-correct model (pm2's own launchd path), not an
 * AppleScript-driven Login Item (auto-launch's model, built for GUI apps
 * with a Dock presence, the wrong shape for a background CLI process).
 * Windows: an HKCU\...\Run registry value via the OS-provided `reg.exe`
 * (no native dependency, matching pi-client.ts's zero-runtime-dependency
 * posture) -- the same mechanism both pm2-windows-startup and auto-launch
 * ship, just shelled out to directly instead of via the `winreg` package.
 * No elevation required.
 */

export interface ServiceSpec {
	/** Used in filenames/labels, e.g. "web-spider". Must be filesystem/registry-value-name safe. */
	name: string;
	/** Human display name, e.g. "Web Spider". Defaults to `name`. */
	displayName?: string;
	/** Absolute path to the daemon's entry point (e.g. a `#!/usr/bin/env bun` cli.ts). */
	binPath: string;
	args?: string[];
	env?: Record<string, string>;
	/** Where the generated descriptor is written -- resolveDaemonPaths().serviceDescriptor. */
	descriptorPath: string;
}

export interface RunResult {
	ok: boolean;
	output: string;
}

export interface ServiceInstallDeps {
	/** Defaults to process.platform. Injectable for tests. */
	platform?: NodeJS.Platform;
	writeFile: (path: string, content: string) => void;
	readFile: (path: string) => string | null;
	removeFile: (path: string) => void;
	fileExists: (path: string) => boolean;
	mkdirp: (path: string) => void;
	/** Runs a command to completion. Never throws -- failures are reported via `ok: false`. */
	runCommand: (command: string, args: string[]) => RunResult;
	/** True when `binary` is resolvable on PATH. */
	which: (binary: string) => boolean;
	/** Linux only -- current numeric uid, used in `launchctl`-equivalent addressing on other platforms is not needed, kept here only for symmetry/tests. */
	uid?: number;
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
	const envLines = Object.entries(withServiceProvenance(spec.env))
		.map(([key, value]) => `Environment=${key}=${value}`)
		.join("\n");
	return [
		"[Unit]",
		`Description=${spec.displayName ?? spec.name}`,
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${execLine}`,
		...(envLines ? [envLines] : []),
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

const LAUNCHD_LABEL_PREFIX = "com.danypops.";

function launchdLabel(name: string): string {
	return `${LAUNCHD_LABEL_PREFIX}${name}`;
}

/**
 * Installs login/boot persistence for `spec` on the current (or injected)
 * platform. Idempotent -- re-running after an existing install overwrites
 * the descriptor and re-registers it, rather than erroring or duplicating.
 */
export function installUserService(spec: ServiceSpec, deps: ServiceInstallDeps): ServiceInstallResult {
	const platform = deps.platform ?? process.platform;

	if (platform === "linux") {
		const initSystem = detectLinuxInitSystem(deps.which);
		if (initSystem !== "systemd") {
			return {
				installed: false,
				reason: initSystem
					? `unsupported Linux init system "${initSystem}" -- only systemd --user is supported; install/start ${spec.binPath} manually`
					: "no supported Linux init system was detected (checked for systemctl/rc-update/update-rc.d/chkconfig)",
			};
		}
		deps.mkdirp(dirnameOf(spec.descriptorPath));
		deps.writeFile(spec.descriptorPath, generateSystemdUnit(spec));
		const reload = deps.runCommand("systemctl", ["--user", "daemon-reload"]);
		if (!reload.ok) return { installed: false, reason: `systemctl --user daemon-reload failed: ${reload.output}` };
		const enable = deps.runCommand("systemctl", ["--user", "enable", "--now", basenameOf(spec.descriptorPath)]);
		if (!enable.ok) return { installed: false, reason: `systemctl --user enable --now failed: ${enable.output}` };
		return { installed: true };
	}

	if (platform === "darwin") {
		deps.mkdirp(dirnameOf(spec.descriptorPath));
		deps.writeFile(spec.descriptorPath, generateLaunchdPlist(spec));
		const uid = deps.uid ?? process.getuid?.() ?? 0;
		const bootstrap = deps.runCommand("launchctl", ["bootstrap", `gui/${uid}`, spec.descriptorPath]);
		if (!bootstrap.ok && !/already bootstrapped|service already loaded/i.test(bootstrap.output)) {
			return { installed: false, reason: `launchctl bootstrap failed: ${bootstrap.output}` };
		}
		return { installed: true };
	}

	if (platform === "win32") {
		const result = deps.runCommand("reg.exe", [
			"add",
			"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
			"/v",
			spec.name,
			"/t",
			"REG_SZ",
			"/d",
			windowsRunCommand(spec),
			"/f",
		]);
		if (!result.ok) return { installed: false, reason: `reg.exe add failed: ${result.output}` };
		return { installed: true };
	}

	return { installed: false, reason: `unsupported platform: ${platform}` };
}

export function uninstallUserService(spec: ServiceSpec, deps: ServiceInstallDeps): ServiceInstallResult {
	const platform = deps.platform ?? process.platform;

	if (platform === "linux") {
		const disable = deps.runCommand("systemctl", ["--user", "disable", "--now", basenameOf(spec.descriptorPath)]);
		deps.removeFile(spec.descriptorPath);
		if (!disable.ok && deps.fileExists(spec.descriptorPath)) {
			return { installed: false, reason: `systemctl --user disable --now failed: ${disable.output}` };
		}
		return { installed: true };
	}

	if (platform === "darwin") {
		const uid = deps.uid ?? process.getuid?.() ?? 0;
		deps.runCommand("launchctl", ["bootout", `gui/${uid}/${launchdLabel(spec.name)}`]);
		deps.removeFile(spec.descriptorPath);
		return { installed: true };
	}

	if (platform === "win32") {
		const result = deps.runCommand("reg.exe", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", spec.name, "/f"]);
		if (!result.ok && !/unable to find the specified registry|cannot find/i.test(result.output)) {
			return { installed: false, reason: `reg.exe delete failed: ${result.output}` };
		}
		return { installed: true };
	}

	return { installed: false, reason: `unsupported platform: ${platform}` };
}

/** Whether spec's descriptor is present. On Linux/macOS this is the generated file; Windows checks the registry value instead. */
export function isServiceInstalled(spec: ServiceSpec, deps: ServiceInstallDeps): boolean {
	const platform = deps.platform ?? process.platform;
	if (platform === "win32") {
		const result = deps.runCommand("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", spec.name]);
		return result.ok;
	}
	return deps.fileExists(spec.descriptorPath);
}

function dirnameOf(path: string): string {
	const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
	const index = path.lastIndexOf(separator);
	return index === -1 ? "." : path.slice(0, index);
}

function basenameOf(path: string): string {
	const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
	const index = path.lastIndexOf(separator);
	return index === -1 ? path : path.slice(index + 1);
}
