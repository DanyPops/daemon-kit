import { describe, expect, it } from "bun:test";
import {
	detectLinuxInitSystem,
	generateLaunchdPlist,
	generateSystemdUnit,
	installUserService,
	isServiceInstalled,
	type RunResult,
	type ServiceInstallDeps,
	type ServiceSpec,
	uninstallUserService,
	windowsRunCommand,
} from "../src/service.ts";

const SPEC: ServiceSpec = {
	name: "acme",
	displayName: "Acme Daemon",
	version: "1.2.3",
	binPath: "/opt/acme/cli.ts",
	args: ["serve"],
	handlePath: "/run/user/1000/acme/handle.json",
	restartOnFailure: true,
	restartSec: 2,
};

function fakeDeps(
	overrides: Partial<ServiceInstallDeps> = {},
): ServiceInstallDeps & { commands: Array<{ command: string; args: string[]; input?: string }> } {
	const commands: Array<{ command: string; args: string[]; input?: string }> = [];
	return {
		commands,
		armadaCliPath: "/armada/cli.js",
		runCommand: (command, args, input): RunResult => {
			commands.push({ command, args, ...(input === undefined ? {} : { input }) });
			return { ok: true, output: "" };
		},
		...overrides,
	};
}

describe("legacy descriptor rendering", () => {
	it("still renders deterministic systemd, launchd, and Windows descriptors for inspection", () => {
		const rendered = { ...SPEC, env: { ACME_MODE: "test" } };
		expect(generateSystemdUnit(rendered)).toContain('ExecStart="/opt/acme/cli.ts" "serve"');
		expect(generateSystemdUnit(rendered)).toContain('Environment="DAEMON_KIT_LAUNCH_PROVENANCE=service"');
		expect(generateSystemdUnit(rendered)).toContain("Restart=always");
		expect(generateLaunchdPlist(rendered)).toContain("com.danypops.acme");
		expect(windowsRunCommand(rendered)).toBe('"/opt/acme/cli.ts" "serve"');
	});

	it("escapes descriptor values", () => {
		expect(generateSystemdUnit({ ...SPEC, env: { WEIRD: 'has "quotes" and \\slashes' } })).toContain(
			'Environment="WEIRD=has \\"quotes\\" and \\\\slashes"',
		);
		expect(generateLaunchdPlist({ ...SPEC, args: ["--flag=<a & b>"] })).toContain("--flag=&lt;a &amp; b&gt;");
	});
});

describe("Armada service ownership", () => {
	it("upserts bounded desired state and reconciles through the published Armada CLI", () => {
		const deps = fakeDeps();
		expect(installUserService(SPEC, deps)).toEqual({ installed: true });
		expect(deps.commands).toHaveLength(2);
		expect(deps.commands[0]).toMatchObject({
			command: process.execPath,
			args: ["/armada/cli.js", "upsert", "--vehicle-file", "-", "--json"],
		});
		expect(JSON.parse(deps.commands[0]?.input ?? "{}")).toEqual({
			name: "acme",
			version: "1.2.3",
			executable: "/opt/acme/cli.ts",
			arguments: ["serve"],
			handlePath: "/run/user/1000/acme/handle.json",
			restart: { policy: "on-failure", delayMs: 2000, maxAttempts: 10, windowMs: 60000 },
			readiness: { timeoutMs: 10000, pollIntervalMs: 100 },
		});
		expect(deps.commands[1]).toEqual({ command: process.execPath, args: ["/armada/cli.js", "reconcile", "--json"] });
	});

	it("fails before mutation when environment or credential material is supplied", () => {
		const deps = fakeDeps();
		expect(installUserService({ ...SPEC, env: { TOKEN: "secret" } }, deps)).toEqual({
			installed: false,
			reason: "Armada service declarations cannot contain environment or credential material",
		});
		expect(deps.commands).toEqual([]);
		expect(installUserService({ ...SPEC, privateTmp: true }, deps)).toEqual({
			installed: false,
			reason: "legacy systemd-only service controls cannot be projected into Armada",
		});
		expect(deps.commands).toEqual([]);
	});

	it("surfaces upsert and reconcile failures", () => {
		const upsertFailure = fakeDeps({ runCommand: () => ({ ok: false, output: "invalid" }) });
		expect(installUserService(SPEC, upsertFailure)).toEqual({ installed: false, reason: "armada upsert failed: invalid" });

		let calls = 0;
		const reconcileFailure = fakeDeps({
			runCommand: () => (++calls === 1 ? { ok: true, output: "" } : { ok: false, output: "native failure" }),
		});
		expect(installUserService(SPEC, reconcileFailure)).toEqual({ installed: false, reason: "armada reconcile failed: native failure" });
	});

	it("removes only through Armada", () => {
		const deps = fakeDeps();
		expect(uninstallUserService(SPEC, deps)).toEqual({ installed: true });
		expect(deps.commands).toEqual([{ command: process.execPath, args: ["/armada/cli.js", "remove", "acme", "--json"] }]);
	});

	it("reads installation state from Armada status", () => {
		const present = fakeDeps({ runCommand: () => ({ ok: true, output: JSON.stringify({ vehicles: [{ name: "acme" }] }) }) });
		expect(isServiceInstalled(SPEC, present)).toBe(true);
		const absent = fakeDeps({ runCommand: () => ({ ok: true, output: JSON.stringify({ vehicles: [] }) }) });
		expect(isServiceInstalled(SPEC, absent)).toBe(false);
	});
});

describe("detectLinuxInitSystem", () => {
	it("detects known init systems for legacy descriptor diagnostics", () => {
		expect(detectLinuxInitSystem((binary) => binary === "systemctl")).toBe("systemd");
		expect(detectLinuxInitSystem((binary) => binary === "rc-update")).toBe("openrc");
		expect(detectLinuxInitSystem(() => false)).toBeNull();
	});
});
