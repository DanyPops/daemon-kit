import { describe, expect, it } from "vitest";
import { executeCleanup, planDuplicateCleanup, type ObservedProcess } from "../src/index.js";
import { vehicle } from "./fixtures.js";

const processes: ObservedProcess[] = [
	{ pid: 42, executable: "/opt/papyrus/cli.js", command: "/opt/papyrus/cli.js serve" },
	{ pid: 43, executable: "/opt/papyrus/cli.js", command: "/opt/papyrus/cli.js serve" },
];

describe("duplicate cleanup", () => {
	it("plans explicit consequences only for unmanaged matching processes", () => {
		const plan = planDuplicateCleanup(vehicle(), 42, { host: "127.0.0.1", port: 4312, pid: 43 }, processes);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.plan.planHash).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.plan.consequences).toEqual([
			{
				pid: 43,
				executable: "/opt/papyrus/cli.js",
				provenance: "unmanaged",
				signal: "SIGTERM",
				interruption: "in-flight requests may fail",
				ownsLiveHandle: true,
			},
		]);
	});

	it("requires exact approval and refuses changed process state without signaling", async () => {
		const planned = planDuplicateCleanup(vehicle(), 42, undefined, processes);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const signaled: number[] = [];
		const terminate = (pid: number) => {
			signaled.push(pid);
			return Promise.resolve({ ok: true as const, diagnostics: [] });
		};
		const wrong = await executeCleanup({
			plan: planned.plan,
			approval: "wrong",
			currentProcesses: () => Promise.resolve(processes),
			managedPid: 42,
			handle: undefined,
			vehicle: vehicle(),
			terminate,
		});
		expect(wrong).toMatchObject({ ok: false, diagnostics: [{ code: "CLEANUP_APPROVAL_INVALID" }] });
		const stale = await executeCleanup({
			plan: planned.plan,
			approval: planned.plan.planHash,
			currentProcesses: () => Promise.resolve([...processes, { pid: 44, executable: "/opt/papyrus/cli.js", command: "/opt/papyrus/cli.js serve" }]),
			managedPid: 42,
			handle: undefined,
			vehicle: vehicle(),
			terminate,
		});
		expect(stale).toMatchObject({ ok: false, diagnostics: [{ code: "CLEANUP_PLAN_STALE" }] });
		expect(signaled).toEqual([]);
	});

	it("signals every approved consequence after revalidation", async () => {
		const planned = planDuplicateCleanup(vehicle(), 42, undefined, processes);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const signaled: number[] = [];
		const outcome = await executeCleanup({
			plan: planned.plan,
			approval: planned.plan.planHash,
			currentProcesses: () => Promise.resolve(processes),
			managedPid: 42,
			handle: undefined,
			vehicle: vehicle(),
			terminate: (pid) => {
				signaled.push(pid);
				return Promise.resolve({ ok: true, diagnostics: [] });
			},
		});
		expect(outcome).toEqual({ ok: true, terminatedPids: [43], diagnostics: [] });
		expect(signaled).toEqual([43]);
	});
});
