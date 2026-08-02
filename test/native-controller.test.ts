import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createNativeController,
	launchdStrategy,
	systemdStrategy,
	windowsTaskSchedulerStrategy,
	type CommandOutcome,
	type CommandRunner,
} from "../src/index.js";
import { vehicle } from "./fixtures.js";

function runner(outputs: CommandOutcome[] = []) {
	const calls: string[][] = [];
	const commandRunner: CommandRunner = {
		run: (command, arguments_) => {
			calls.push([command, ...arguments_]);
			return Promise.resolve(outputs.shift() ?? { ok: true, stdout: "", stderr: "" });
		},
	};
	return { commandRunner, calls };
}

describe("native controller", () => {
	it("writes, reloads, starts, stops, and inspects systemd user units", async () => {
		const root = await mkdtemp(join(tmpdir(), "armada-systemd-"));
		const empty = { ok: true as const, stdout: "", stderr: "" };
		const fake = runner([empty, empty, empty, { ok: true, stdout: "LoadState=loaded\nActiveState=active\nMainPID=42\n", stderr: "" }]);
		const controller = createNativeController({ kind: "systemd", descriptorRoot: root, commandRunner: fake.commandRunner });
		const generated = systemdStrategy.generateDescriptor(vehicle());
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		expect((await controller.replaceDescriptorAtomically(generated.descriptor)).ok).toBe(true);
		expect((await controller.start(generated.descriptor.identity)).ok).toBe(true);
		expect((await controller.stop(generated.descriptor.identity)).ok).toBe(true);
		const inspected = await controller.inspect([vehicle()]);
		expect(inspected).toMatchObject({ ok: true, services: [{ status: "running", pid: 42, specHash: generated.descriptor.specHash }] });
		expect(fake.calls).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "start", "armada-papyrus.service"],
			["systemctl", "--user", "stop", "armada-papyrus.service"],
			["systemctl", "--user", "show", "armada-papyrus.service", "--property=LoadState", "--property=ActiveState", "--property=MainPID", "--no-pager"],
		]);
	});

	it("maps launchd and Task Scheduler lifecycle commands without a resident supervisor", async () => {
		const root = await mkdtemp(join(tmpdir(), "armada-native-"));
		const launch = runner();
		const launchController = createNativeController({
			kind: "launchd",
			descriptorRoot: root,
			commandRunner: launch.commandRunner,
			userId: 501,
		});
		const launchDescriptor = launchdStrategy.generateDescriptor(vehicle({ restart: { policy: "never" } }));
		expect(launchDescriptor.ok).toBe(true);
		if (!launchDescriptor.ok) return;
		await launchController.replaceDescriptorAtomically(launchDescriptor.descriptor);
		await launchController.start(launchDescriptor.descriptor.identity);
		await launchController.stop(launchDescriptor.descriptor.identity);
		expect(launch.calls).toEqual([
			["launchctl", "bootstrap", "gui/501", join(root, "dev.danypops.armada.papyrus.plist")],
			["launchctl", "bootout", "gui/501/dev.danypops.armada.papyrus"],
		]);

		const windows = runner();
		const windowsController = createNativeController({
			kind: "windows-task-scheduler",
			descriptorRoot: root,
			commandRunner: windows.commandRunner,
		});
		const windowsDescriptor = windowsTaskSchedulerStrategy.generateDescriptor(vehicle());
		expect(windowsDescriptor.ok).toBe(true);
		if (!windowsDescriptor.ok) return;
		await windowsController.replaceDescriptorAtomically(windowsDescriptor.descriptor);
		await windowsController.start(windowsDescriptor.descriptor.identity);
		await windowsController.stop(windowsDescriptor.descriptor.identity);
		expect(windows.calls).toEqual([
			["schtasks", "/Create", "/TN", "\\Armada\\papyrus", "/XML", join(root, "papyrus.xml"), "/F"],
			["schtasks", "/Run", "/TN", "\\Armada\\papyrus"],
			["schtasks", "/End", "/TN", "\\Armada\\papyrus"],
		]);
	});
});
