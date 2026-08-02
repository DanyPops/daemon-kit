/**
 * Walking skeleton for a subagent/job/goal-orchestration extension (the
 * shape pi-subagents, pi-crew, pi-fabric, and their forks all hand-roll):
 * submit a long-running unit of work, get a job id back immediately, poll
 * it later. Monolith Mode (no daemon) -- see the root README's "Split vs
 * Monolith" section for when you'd want the daemon-backed Split shape
 * instead (state must outlive this Pi session, or several sessions share
 * one job queue).
 *
 * Rename `work.run`/`work.submit`/`work.poll` to your own domain
 * (`research.run`, `research.submit`, `research.poll`, ...) and replace
 * `runWork`'s body with your real long-running task.
 */
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { VehicleJobStore } from "@danypops/vehicle-server/jobs";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { createMonolithVehicle } from "@danypops/vehicle-client-pi/monolith";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 4_096, maxResponseBytes: 65_536 };
const WAKE_BUDGET = { maxCount: 32, maxBytes: 65_536 };

interface RunWorkInput {
	readonly topic: string;
}

const runWorkSchema = defineVehicleSchema<RunWorkInput>({
	jsonSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
	safeParse(value) {
		if (typeof value !== "object" || value === null || typeof (value as { topic?: unknown }).topic !== "string") {
			return { success: false, issues: [{ path: ["topic"], message: "topic is required and must be a string" }] };
		}
		return { success: true, value: value as RunWorkInput };
	},
});

const jsonSchema = defineVehicleSchema<Record<string, unknown>>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> }),
});

/** Replace this with your own real long-running task -- a real one would take seconds to minutes, not milliseconds. */
export async function runWork(input: RunWorkInput): Promise<{ topic: string; result: string }> {
	await new Promise((resolve) => setTimeout(resolve, 50));
	return { topic: input.topic, result: `researched "${input.topic}": (replace this with a real result)` };
}

const pollSchema = defineVehicleSchema<{ jobId: string }>({
	jsonSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
	safeParse(value) {
		if (typeof value !== "object" || value === null || typeof (value as { jobId?: unknown }).jobId !== "string") {
			return { success: false, issues: [{ path: ["jobId"], message: "jobId is required" }] };
		}
		return { success: true, value: value as { jobId: string } };
	},
});

/**
 * Registers work.run/work.submit/work.poll against `registry` and returns
 * the VehicleJobStore backing them -- factored out from the extension's
 * default export so this skeleton's own test suite can exercise it directly
 * against a real VehicleRegistry, no Pi extension host needed.
 */
export function registerWorkOperations(registry: VehicleRegistry): VehicleJobStore {
	const jobStore = new VehicleJobStore(registry);

	// The actual background-capable unit of work. longRunning + background
	// declare it eligible for VehicleJobStore.submit() below; it is never
	// invoked directly by a Pi tool call (see work.submit/work.poll instead).
	const runOperation = defineVehicleOperation({
		name: "work.run",
		version: 1,
		description: "Runs one unit of background work. Submitted via work.submit, checked via work.poll -- never called directly.",
		input: runWorkSchema,
		output: jsonSchema,
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		longRunning: true,
		limits: LIMITS,
		background: { supported: true, defaultWakeBudget: WAKE_BUDGET, maxWakeBudget: WAKE_BUDGET },
	});
	registry.register(
		"work",
		bindVehicleOperation(runOperation, () => async (context) => runWork(context.input)),
	);

	const submitOperation = defineVehicleOperation({
		name: "work.submit",
		version: 1,
		description: "Starts a background research task and returns its job id immediately -- check progress with work.poll.",
		input: runWorkSchema,
		output: jsonSchema,
		permissions: [],
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		"work",
		bindVehicleOperation(submitOperation, () => async (context) => jobStore.submit("work.run", 1, context.input)),
	);

	const pollOperation = defineVehicleOperation({
		name: "work.poll",
		version: 1,
		description: "Checks a background job's current status (running/succeeded/failed/canceled) and, once finished, its result.",
		input: pollSchema,
		output: jsonSchema,
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		"work",
		bindVehicleOperation(pollOperation, () => async (context) => ({ ...jobStore.poll(context.input.jobId) })),
	);

	return jobStore;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", async () => {
		await createMonolithVehicle(
			pi,
			{ name: "job-orchestration-template", version: "1.0.0", description: "Submit/poll a background job." },
			registerWorkOperations,
		);
	});
}
