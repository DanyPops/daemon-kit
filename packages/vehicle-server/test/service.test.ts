import { describe, expect, it } from "bun:test";
import type { VehicleRegistrar, VehicleRegistrationOutcome } from "@danypops/armada";
import {
	armadaUnitName,
	createNodeServiceInstallDeps,
	createServiceCli,
	detectLinuxInitSystem,
	generateLaunchdPlist,
	generateSystemdUnit,
	installUserService,
	isServiceInstalled,
	isVehicleServiceRegistered,
	type RunResult,
	registerVehicleService,
	type ServiceInstallDeps,
	type ServiceSpec,
	uninstallUserService,
	unregisterVehicleService,
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
	it("resolves Armada's ESM-only CLI export", () => {
		expect(createNodeServiceInstallDeps().armadaCliPath).toEndWith("/dist/cli.js");
	});

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
		expect(uninstallUserService(SPEC.name, deps)).toEqual({ installed: true });
		expect(deps.commands).toEqual([{ command: process.execPath, args: ["/armada/cli.js", "remove", "acme", "--json"] }]);
	});

	it("reads installation state from Armada status", () => {
		const present = fakeDeps({ runCommand: () => ({ ok: true, output: JSON.stringify({ vehicles: [{ name: "acme" }] }) }) });
		expect(isServiceInstalled(SPEC.name, present)).toBe(true);
		const absent = fakeDeps({ runCommand: () => ({ ok: true, output: JSON.stringify({ vehicles: [] }) }) });
		expect(isServiceInstalled(SPEC.name, absent)).toBe(false);
	});
});

class FakeVehicleRegistrar implements VehicleRegistrar {
	registerCalls: unknown[] = [];
	unregisterCalls: string[] = [];
	registeredNames = new Set<string>();
	outcome: VehicleRegistrationOutcome = { ok: true, manifestHash: "hash" as never, applied: [], diagnostics: [] };
	async register(vehicle: unknown): Promise<VehicleRegistrationOutcome> {
		this.registerCalls.push(vehicle);
		if (this.outcome.ok) this.registeredNames.add((vehicle as { name: string }).name);
		return this.outcome;
	}
	async unregister(name: string): Promise<VehicleRegistrationOutcome> {
		this.unregisterCalls.push(name);
		if (this.outcome.ok) this.registeredNames.delete(name);
		return this.outcome;
	}
	async isRegistered(name: string): Promise<boolean> {
		return this.registeredNames.has(name);
	}
}

describe("Armada service ownership -- in-process registrar path", () => {
	it("registers a Vehicle spec through the registrar directly, no subprocess", async () => {
		const registrar = new FakeVehicleRegistrar();
		const result = await registerVehicleService(SPEC, registrar);
		expect(result).toEqual({ installed: true });
		expect(registrar.registerCalls).toEqual([
			{
				name: "acme",
				version: "1.2.3",
				executable: "/opt/acme/cli.ts",
				arguments: ["serve"],
				handlePath: "/run/user/1000/acme/handle.json",
				restart: { policy: "on-failure", delayMs: 2000, maxAttempts: 10, windowMs: 60000 },
				readiness: { timeoutMs: 10000, pollIntervalMs: 100 },
			},
		]);
	});

	it("fails before ever calling the registrar when environment or credential material is supplied", async () => {
		const registrar = new FakeVehicleRegistrar();
		const result = await registerVehicleService({ ...SPEC, env: { TOKEN: "secret" } }, registrar);
		expect(result).toEqual({
			installed: false,
			reason: "Armada service declarations cannot contain environment or credential material",
		});
		expect(registrar.registerCalls).toEqual([]);
	});

	it("surfaces a failed registration's diagnostics as the reason", async () => {
		const registrar = new FakeVehicleRegistrar();
		registrar.outcome = { ok: false, diagnostics: [{ code: "X", severity: "error", path: "/", message: "native failure" }] };
		const result = await registerVehicleService(SPEC, registrar);
		expect(result).toEqual({ installed: false, reason: "native failure" });
	});

	it("unregisters and reports registration status through the registrar directly", async () => {
		const registrar = new FakeVehicleRegistrar();
		await registerVehicleService(SPEC, registrar);
		expect(await isVehicleServiceRegistered(SPEC.name, registrar)).toBe(true);

		const result = await unregisterVehicleService(SPEC.name, registrar);
		expect(result).toEqual({ installed: true });
		expect(registrar.unregisterCalls).toEqual(["acme"]);
		expect(await isVehicleServiceRegistered(SPEC.name, registrar)).toBe(false);
	});
});

describe("createServiceCli", () => {
	it("derives the real Armada unit name from the spec's own name", () => {
		expect(armadaUnitName("acme")).toBe("armada-acme.service");
		expect(createServiceCli(SPEC, fakeDeps()).unitName).toBe("armada-acme.service");
	});

	it("install/uninstall delegate to the same installUserService/uninstallUserService Armada calls", () => {
		const deps = fakeDeps();
		const cli = createServiceCli(SPEC, deps);
		expect(cli.install()).toEqual({ installed: true });
		expect(cli.uninstall()).toEqual({ installed: true });
		expect(deps.commands.map((call) => call.args[1])).toEqual(["upsert", "reconcile", "remove"]);
	});

	it("action() runs systemctl --user <action> against the real Armada unit name, not the spec's bare name", () => {
		const calls: Array<{ action: string; unitName: string }> = [];
		const cli = createServiceCli(SPEC, { ...fakeDeps(), runSystemctl: (action, unitName) => calls.push({ action, unitName }) });
		for (const action of ["start", "stop", "restart", "status"] as const) cli.action(action);
		expect(calls).toEqual([
			{ action: "start", unitName: "armada-acme.service" },
			{ action: "stop", unitName: "armada-acme.service" },
			{ action: "restart", unitName: "armada-acme.service" },
			{ action: "status", unitName: "armada-acme.service" },
		]);
	});
});

describe("detectLinuxInitSystem", () => {
	it("detects known init systems for legacy descriptor diagnostics", () => {
		expect(detectLinuxInitSystem((binary) => binary === "systemctl")).toBe("systemd");
		expect(detectLinuxInitSystem((binary) => binary === "rc-update")).toBe("openrc");
		expect(detectLinuxInitSystem(() => false)).toBeNull();
	});
});
