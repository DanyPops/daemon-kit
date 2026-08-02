import { describe, expect, it } from "vitest";
import {
	launchdStrategy,
	systemdStrategy,
	windowsTaskSchedulerStrategy,
	type NativeServiceStrategy,
} from "../src/index.js";
import { vehicle } from "./fixtures.js";

const strategies: readonly NativeServiceStrategy[] = [systemdStrategy, launchdStrategy, windowsTaskSchedulerStrategy];

describe("native service strategies", () => {
	it("generate deterministic Armada-owned identities and descriptors", () => {
		for (const strategy of strategies) {
			const spec = vehicle({ restart: { policy: "never" } });
			const first = strategy.generateDescriptor(spec);
			const second = strategy.generateDescriptor(spec);
			expect(first).toEqual(second);
			expect(first.ok).toBe(true);
			if (!first.ok) continue;
			expect(first.descriptor.kind).toBe(strategy.kind);
			expect(first.descriptor.specHash).toMatch(/^[a-f0-9]{64}$/);
			expect(first.descriptor.content).toContain(first.descriptor.specHash);
		}
	});

	it("maps bounded restart and resource controls to a systemd user unit", () => {
		const outcome = systemdStrategy.generateDescriptor(
			vehicle({
				executable: "/opt/Armada Vehicle/papyrus",
				arguments: ["serve", "a value"],
				workingDirectory: "/var/lib/papyrus",
				resources: {
					maximumMemoryBytes: { value: 268_435_456, enforcement: "required" },
					maximumCpuPercent: { value: 75, enforcement: "required" },
					maximumTasks: { value: 32, enforcement: "required" },
				},
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.descriptor.identity).toBe("armada-papyrus.service");
		expect(outcome.descriptor.fileName).toBe("armada-papyrus.service");
		expect(outcome.descriptor.content).toContain('ExecStart="/opt/Armada Vehicle/papyrus" "serve" "a value"');
		expect(outcome.descriptor.content).toContain("Restart=on-failure");
		expect(outcome.descriptor.content).toContain("StartLimitIntervalSec=60");
		expect(outcome.descriptor.content).toContain("StartLimitBurst=4");
		expect(outcome.descriptor.content).toContain("MemoryMax=268435456");
		expect(outcome.descriptor.content).toContain("CPUQuota=75%");
		expect(outcome.descriptor.content).toContain("TasksMax=32");
		expect(outcome.diagnostics).toEqual([]);
	});

	it("rejects descriptor control-character injection", () => {
		const outcome = systemdStrategy.generateDescriptor(vehicle({ arguments: ["serve\n[Install]"] }));
		expect(outcome).toMatchObject({ ok: false, diagnostics: [{ code: "NATIVE_DESCRIPTOR_TEXT_INVALID", severity: "error" }] });
	});

	it("fails launchd generation when bounded restart semantics are requested", () => {
		const outcome = launchdStrategy.generateDescriptor(vehicle());
		expect(outcome).toMatchObject({
			ok: false,
			diagnostics: [{ code: "NATIVE_RESTART_ATTEMPT_LIMIT_UNSUPPORTED", severity: "error" }],
		});
	});

	it("emits a launchd LaunchAgent and reports optional unsupported controls", () => {
		const outcome = launchdStrategy.generateDescriptor(
			vehicle({
				restart: { policy: "never" },
				arguments: ["serve", "a&b"],
				resources: { maximumMemoryBytes: { value: 1024, enforcement: "optional" } },
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.descriptor.identity).toBe("dev.danypops.armada.papyrus");
		expect(outcome.descriptor.fileName).toBe("dev.danypops.armada.papyrus.plist");
		expect(outcome.descriptor.content).toContain("<string>a&amp;b</string>");
		expect(outcome.descriptor.content).toContain("<key>RunAtLoad</key>");
		expect(outcome.diagnostics).toMatchObject([{ code: "NATIVE_RESOURCE_UNSUPPORTED_OPTIONAL", severity: "warning" }]);
	});

	it("maps bounded on-failure restart to Task Scheduler and reports its missing window control", () => {
		const outcome = windowsTaskSchedulerStrategy.generateDescriptor(
			vehicle({ executable: "C:\\Program Files\\Papyrus\\papyrus.exe", arguments: ["serve", "a value"] }),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.descriptor.identity).toBe("\\Armada\\papyrus");
		expect(outcome.descriptor.fileName).toBe("papyrus.xml");
		expect(outcome.descriptor.content).toContain("<Command>C:\\Program Files\\Papyrus\\papyrus.exe</Command>");
		expect(outcome.descriptor.content).toContain("<Arguments>serve &quot;a value&quot;</Arguments>");
		expect(outcome.descriptor.content).toContain("<Count>3</Count>");
		expect(outcome.descriptor.content).toContain("<Interval>PT1S</Interval>");
		expect(outcome.descriptor.content).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
		expect(outcome.diagnostics).toMatchObject([{ code: "NATIVE_RESTART_WINDOW_UNSUPPORTED", severity: "warning" }]);
	});

	it("rejects unsupported required resources and restart modes", () => {
		const resource = windowsTaskSchedulerStrategy.generateDescriptor(
			vehicle({
				restart: { policy: "never" },
				resources: { maximumTasks: { value: 4, enforcement: "required" } },
			}),
		);
		expect(resource).toMatchObject({ ok: false, diagnostics: [{ code: "NATIVE_RESOURCE_UNSUPPORTED_REQUIRED" }] });

		const restart = windowsTaskSchedulerStrategy.generateDescriptor(
			vehicle({ restart: { policy: "always", delayMs: 1_000, maxAttempts: 3, windowMs: 60_000 } }),
		);
		expect(restart).toMatchObject({ ok: false, diagnostics: [{ code: "NATIVE_RESTART_MODE_UNSUPPORTED" }] });
	});
});
