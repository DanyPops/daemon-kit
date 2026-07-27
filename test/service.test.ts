import { describe, expect, it } from "bun:test";
import {
	detectLinuxInitSystem,
	generateLaunchdPlist,
	generateSystemdUnit,
	installUserService,
	isServiceInstalled,
	uninstallUserService,
	windowsRunCommand,
	type RunResult,
	type ServiceInstallDeps,
	type ServiceSpec,
} from "../src/service.ts";

const SPEC: ServiceSpec = {
	name: "acme",
	displayName: "Acme Daemon",
	binPath: "/opt/acme/cli.ts",
	args: ["serve"],
	env: { ACME_TOKEN: "s3cr3t" },
	descriptorPath: "/config/systemd/user/acme.service",
};

function fakeDeps(overrides: Partial<ServiceInstallDeps> = {}): ServiceInstallDeps & { files: Map<string, string>; commands: Array<{ command: string; args: string[] }> } {
	const files = new Map<string, string>();
	const commands: Array<{ command: string; args: string[] }> = [];
	const deps: ServiceInstallDeps & { files: Map<string, string>; commands: typeof commands } = {
		files,
		commands,
		writeFile: (path, content) => files.set(path, content),
		readFile: (path) => files.get(path) ?? null,
		removeFile: (path) => files.delete(path),
		fileExists: (path) => files.has(path),
		mkdirp: () => {},
		runCommand: (command, args): RunResult => {
			commands.push({ command, args });
			return { ok: true, output: "" };
		},
		which: () => true,
		...overrides,
	};
	return deps;
}

describe("detectLinuxInitSystem", () => {
	it("picks systemd when systemctl is present", () => {
		expect(detectLinuxInitSystem((binary) => binary === "systemctl")).toBe("systemd");
	});

	it("picks openrc when only rc-update is present", () => {
		expect(detectLinuxInitSystem((binary) => binary === "rc-update")).toBe("openrc");
	});

	it("returns null when no known init system binary is found", () => {
		expect(detectLinuxInitSystem(() => false)).toBeNull();
	});
});

describe("generateSystemdUnit", () => {
	it("includes ExecStart, Environment lines, and no Restart= directive", () => {
		const unit = generateSystemdUnit(SPEC);
		expect(unit).toContain('ExecStart="/opt/acme/cli.ts" "serve"');
		expect(unit).toContain("Environment=ACME_TOKEN=s3cr3t");
		expect(unit).toContain("Description=Acme Daemon");
		expect(unit).not.toContain("Restart=");
	});
});

describe("generateLaunchdPlist", () => {
	it("is valid-shaped plist XML with RunAtLoad and no KeepAlive", () => {
		const plist = generateLaunchdPlist(SPEC);
		expect(plist).toContain("<key>Label</key>");
		expect(plist).toContain("com.danypops.acme");
		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("<true/>");
		expect(plist).toContain("<string>/opt/acme/cli.ts</string>");
		expect(plist).toContain("<string>serve</string>");
		expect(plist).toContain("ACME_TOKEN");
		expect(plist).not.toContain("KeepAlive");
	});

	it("escapes XML-significant characters in values", () => {
		const plist = generateLaunchdPlist({ ...SPEC, args: ["--flag=<a & b>"] });
		expect(plist).toContain("--flag=&lt;a &amp; b&gt;");
	});
});

describe("windowsRunCommand", () => {
	it("quotes each argument", () => {
		expect(windowsRunCommand(SPEC)).toBe('"/opt/acme/cli.ts" "serve"');
	});
});

describe("installUserService", () => {
	it("Linux + systemd: writes the unit, reloads, and enables --now", () => {
		const deps = fakeDeps({ platform: "linux", which: (b) => b === "systemctl" });
		const result = installUserService(SPEC, deps);
		expect(result).toEqual({ installed: true });
		expect(deps.files.get(SPEC.descriptorPath)).toContain("ExecStart");
		expect(deps.commands).toEqual([
			{ command: "systemctl", args: ["--user", "daemon-reload"] },
			{ command: "systemctl", args: ["--user", "enable", "--now", "acme.service"] },
		]);
	});

	it("Linux without systemd: fails clearly instead of guessing", () => {
		const deps = fakeDeps({ platform: "linux", which: (b) => b === "rc-update" });
		const result = installUserService(SPEC, deps);
		expect(result.installed).toBe(false);
		expect((result as { reason: string }).reason).toContain("openrc");
		expect(deps.files.size).toBe(0);
	});

	it("Linux with no detectable init system: fails clearly", () => {
		const deps = fakeDeps({ platform: "linux", which: () => false });
		const result = installUserService(SPEC, deps);
		expect(result.installed).toBe(false);
		expect((result as { reason: string }).reason).toContain("no supported Linux init system");
	});

	it("Linux: a systemctl failure surfaces its output instead of silently succeeding", () => {
		const deps = fakeDeps({
			platform: "linux",
			which: (b) => b === "systemctl",
			runCommand: (command, args) => (args.includes("enable") ? { ok: false, output: "permission denied" } : { ok: true, output: "" }),
		});
		const result = installUserService(SPEC, deps);
		expect(result).toEqual({ installed: false, reason: "systemctl --user enable --now failed: permission denied" });
	});

	it("macOS: writes the plist and bootstraps it via launchctl", () => {
		const deps = fakeDeps({ platform: "darwin", uid: 501, descriptorPath: "/Users/x/Library/LaunchAgents/com.danypops.acme.plist" } as Partial<ServiceInstallDeps>);
		const spec = { ...SPEC, descriptorPath: "/Users/x/Library/LaunchAgents/com.danypops.acme.plist" };
		const result = installUserService(spec, deps);
		expect(result).toEqual({ installed: true });
		expect(deps.files.get(spec.descriptorPath)).toContain("RunAtLoad");
		expect(deps.commands).toEqual([{ command: "launchctl", args: ["bootstrap", "gui/501", spec.descriptorPath] }]);
	});

	it("macOS: re-installing (already bootstrapped) is treated as success, not failure -- idempotent", () => {
		const deps = fakeDeps({
			platform: "darwin",
			uid: 501,
			runCommand: () => ({ ok: false, output: "service already loaded" }),
		});
		const result = installUserService(SPEC, deps);
		expect(result).toEqual({ installed: true });
	});

	it("Windows: adds an HKCU Run registry value via reg.exe, no elevation", () => {
		const deps = fakeDeps({ platform: "win32" });
		const result = installUserService(SPEC, deps);
		expect(result).toEqual({ installed: true });
		expect(deps.commands).toEqual([
			{
				command: "reg.exe",
				args: ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "acme", "/t", "REG_SZ", "/d", '"/opt/acme/cli.ts" "serve"', "/f"],
			},
		]);
	});

	it("Windows: a reg.exe failure surfaces its output", () => {
		const deps = fakeDeps({ platform: "win32", runCommand: () => ({ ok: false, output: "access is denied" }) });
		const result = installUserService(SPEC, deps);
		expect(result).toEqual({ installed: false, reason: "reg.exe add failed: access is denied" });
	});
});

describe("uninstallUserService", () => {
	it("Linux: disables and removes the unit file", () => {
		const deps = fakeDeps({ platform: "linux", which: (b) => b === "systemctl" });
		deps.files.set(SPEC.descriptorPath, "content");
		const result = uninstallUserService(SPEC, deps);
		expect(result).toEqual({ installed: true });
		expect(deps.files.has(SPEC.descriptorPath)).toBe(false);
	});

	it("Windows: deletes the registry value, treating already-absent as success (idempotent)", () => {
		const deps = fakeDeps({ platform: "win32", runCommand: () => ({ ok: false, output: "The system was unable to find the specified registry key or value." }) });
		const result = uninstallUserService(SPEC, deps);
		expect(result).toEqual({ installed: true });
	});
});

describe("isServiceInstalled", () => {
	it("Linux/macOS: true exactly when the descriptor file exists", () => {
		const deps = fakeDeps({ platform: "linux" });
		expect(isServiceInstalled(SPEC, deps)).toBe(false);
		deps.files.set(SPEC.descriptorPath, "x");
		expect(isServiceInstalled(SPEC, deps)).toBe(true);
	});

	it("Windows: checks the registry value via reg.exe query", () => {
		const deps = fakeDeps({ platform: "win32", runCommand: () => ({ ok: true, output: "REG_SZ" }) });
		expect(isServiceInstalled(SPEC, deps)).toBe(true);
	});
});
