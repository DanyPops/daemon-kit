import { describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import {
	bindVehicleOperation,
	defineLooseObjectSchema,
	defineVehicleOperation,
	isVehicleError,
	passthroughVehicleSchema,
} from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { VehicleJobStore } from "@danypops/vehicle-server/jobs";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Reproduces pi-pipes' real ci.wait bug against the actual vehicle-server
 * VehicleRegistry (not a reimplementation): a longRunning: true operation's
 * own limits.maxTimeoutMs still hard-clamps invoke(), because longRunning
 * is descriptor metadata invoke() never reads. Then proves the framework's
 * own answer to "an operation that must run past any sane live-call
 * ceiling": VehicleRegistry.resolveForBackground() + VehicleJobStore
 * (@danypops/vehicle-server/jobs), submitted once and polled/tailed by id.
 * Those calls never construct a deadline at all, so no maxTimeoutMs ever
 * applies to them regardless of how long the job itself takes.
 *
 * The job-backed half is wired all the way through as real Pi tools via
 * @danypops/pi-extension-harness -- the same harness vehicle-client-pi's
 * own vehicle-pi.test.ts uses -- so this exercises the tool boundary a
 * model would actually call through, not just the store's own API.
 */

const TINY_LIMITS = { defaultTimeoutMs: 20, maxTimeoutMs: 40, maxRequestBytes: 4_096, maxResponseBytes: 4_096 };
const JOB_WAKE_BUDGET = { maxCount: 50, maxBytes: 50_000 };

const runInput = defineLooseObjectSchema({ runId: { type: "string" } }, ["runId"]);

/** A handler this test controls by hand -- no real timers, no sleeping past a real 30s+ deadline to prove the point. */
function controllableWaitHandler() {
	let resolveHandler!: (output: unknown) => void;
	let rejectHandler!: (error: unknown) => void;
	let reportProgress!: (progress: unknown) => void;
	let startedResolve!: () => void;
	// resolved the moment the handler is actually invoked and has captured reportProgress
	const started = new Promise<void>((res) => {
		startedResolve = res;
	});

	const handler = (context: { reportProgress: (progress: unknown) => void }) => {
		reportProgress = context.reportProgress;
		startedResolve();
		return new Promise((resolve, reject) => {
			resolveHandler = resolve;
			rejectHandler = reject;
		});
	};

	return {
		handler,
		started,
		tick: (progress: unknown) => reportProgress(progress),
		succeed: (output: unknown) => resolveHandler(output),
		fail: (error: unknown) => rejectHandler(error),
	};
}

function registryWithOwner(): VehicleRegistry {
	return new VehicleRegistry({ name: "ci-wait-harness", version: "1.0.0", description: "ci.wait job harness under test." });
}

describe("ci.wait: reproduces the real invoke()-deadline-clamp bug", () => {
	// Clamps regardless of the requested deadline, and really does abort a still-running handler.
	it("clamps a longRunning invoke() to its own maxTimeoutMs", async () => {
		const registry = registryWithOwner();
		const wait = controllableWaitHandler();
		const operation = defineVehicleOperation({
			name: "ci.wait.legacy",
			version: 1,
			description:
				"The exact shape pipes-vehicle.ts registers ci.wait under today: longRunning: true sharing the generic read-operation LIMITS.",
			input: runInput,
			output: passthroughVehicleSchema,
			effect: "read",
			idempotency: { mode: "safe" },
			longRunning: true,
			limits: TINY_LIMITS,
		});
		registry.register(
			"pipes",
			bindVehicleOperation(operation, () => wait.handler as never),
		);

		// Caller asks for far longer than maxTimeoutMs -- exactly ci_wait(timeoutS: 900) against
		// a 30s-capped operation. effectiveDeadline() clamps to now + maxTimeoutMs regardless.
		const requestedDeadline = Date.now() + 10_000;
		const failure = await registry
			.invoke("ci.wait.legacy", 1, { runId: "1" }, { deadline: requestedDeadline })
			.catch((error: unknown) => error);

		expect(isVehicleError(failure)).toBe(true);
		expect((failure as { code: string }).code).toBe("deadline-exceeded");

		// The handler is still sitting there, never resolved -- invoke() gave up on it, it did not
		// actually finish. Cleaning it up so the test process doesn't hang on an open promise.
		wait.succeed({ status: "success" });
	});
});

/** Registers the job-backed ci_wait_* tools a real pi-pipes extension would expose once ci.wait moves onto Vehicle Jobs. */
function registerCiWaitJobTools(pi: ExtensionAPI, jobStore: VehicleJobStore): void {
	const textResult = (details: unknown): AgentToolResult<unknown> => ({
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
	});

	const submitTool: ToolDefinition = {
		name: "ci_wait_submit",
		label: "ci wait submit",
		description: "Starts watching a run in the background; returns a jobId immediately, never blocking on the run itself.",
		parameters: Type.Object({ runId: Type.String() }),
		async execute(_toolCallId, params: { runId: string }) {
			const { jobId } = jobStore.submit("ci.wait", 1, { runId: params.runId }, { wakeBudget: JOB_WAKE_BUDGET });
			return textResult({ jobId });
		},
	};

	const pollTool: ToolDefinition = {
		name: "ci_wait_poll",
		label: "ci wait poll",
		description: "Never blocks -- current job status, plus output/error once terminal.",
		parameters: Type.Object({ jobId: Type.String() }),
		async execute(_toolCallId, params: { jobId: string }) {
			return textResult(jobStore.poll(params.jobId));
		},
	};

	const tailTool: ToolDefinition = {
		name: "ci_wait_tail",
		label: "ci wait tail",
		description: "Progress entries since a cursor, plus the next cursor. Never blocks.",
		parameters: Type.Object({ jobId: Type.String(), cursor: Type.Optional(Type.Number()) }),
		async execute(_toolCallId, params: { jobId: string; cursor?: number }) {
			return textResult(jobStore.tail(params.jobId, params.cursor ?? 0));
		},
	};

	const cancelTool: ToolDefinition = {
		name: "ci_wait_cancel",
		label: "ci wait cancel",
		description: "Best-effort cancellation of a still-running watch.",
		parameters: Type.Object({ jobId: Type.String() }),
		async execute(_toolCallId, params: { jobId: string }) {
			jobStore.cancel(params.jobId);
			return textResult({ ok: true });
		},
	};

	for (const tool of [submitTool, pollTool, tailTool, cancelTool]) pi.registerTool(tool as ToolDefinition);
}

describe("ci.wait as a Vehicle Job: submit/poll/tail/cancel never hit any deadline clamp", () => {
	function harnessWithJobBackedCiWait() {
		const registry = registryWithOwner();
		const wait = controllableWaitHandler();
		const operation = defineVehicleOperation({
			name: "ci.wait",
			version: 1,
			description: "ci.wait, moved onto Vehicle Jobs: submit/poll/tail/cancel by id instead of one blocking invoke().",
			input: runInput,
			output: passthroughVehicleSchema,
			effect: "read",
			idempotency: { mode: "safe" },
			longRunning: true,
			limits: TINY_LIMITS,
			background: { supported: true, defaultWakeBudget: JOB_WAKE_BUDGET, maxWakeBudget: JOB_WAKE_BUDGET },
		});
		registry.register(
			"pipes",
			bindVehicleOperation(operation, () => wait.handler as never),
		);
		const jobStore = new VehicleJobStore(registry);

		const harness = createExtensionHarness((pi) => registerCiWaitJobTools(pi, jobStore));
		return { harness, wait, jobStore };
	}

	// No wait for the handler; no deadline to clamp.
	it("ci_wait_submit returns a jobId immediately", async () => {
		const { harness, wait } = harnessWithJobBackedCiWait();
		await harness.boot();

		const submitted = (await harness.invokeTool("ci_wait_submit", { runId: "42" })) as AgentToolResult<{ jobId: string }>;
		expect(typeof submitted.details.jobId).toBe("string");
		await wait.started; // the job really did start running server-side

		wait.succeed({ status: "success" });
		await harness.shutdown();
	});

	// Neither call ever times out.
	it("ci_wait_poll reports running, then succeeded with the handler's real output", async () => {
		const { harness, wait } = harnessWithJobBackedCiWait();
		await harness.boot();

		const submitted = (await harness.invokeTool("ci_wait_submit", { runId: "42" })) as AgentToolResult<{ jobId: string }>;
		const jobId = submitted.details.jobId;
		await wait.started;

		const runningPoll = (await harness.invokeTool("ci_wait_poll", { jobId })) as AgentToolResult<{ status: string }>;
		expect(runningPoll.details.status).toBe("running");

		wait.succeed({ status: "success", conclusion: "success" });
		await Promise.resolve(); // let the job's own .then() finalize before polling again
		await Promise.resolve();

		const terminalPoll = (await harness.invokeTool("ci_wait_poll", { jobId })) as AgentToolResult<{
			status: string;
			output?: unknown;
		}>;
		expect(terminalPoll.details.status).toBe("succeeded");
		expect(terminalPoll.details.output).toEqual({ status: "success", conclusion: "success" });

		await harness.shutdown();
	});

	it("ci_wait_tail accumulates every progress tick, cursor advancing each time", async () => {
		const { harness, wait } = harnessWithJobBackedCiWait();
		await harness.boot();

		const submitted = (await harness.invokeTool("ci_wait_submit", { runId: "42" })) as AgentToolResult<{ jobId: string }>;
		const jobId = submitted.details.jobId;
		await wait.started;

		wait.tick({ status: "queued" });
		wait.tick({ status: "in_progress" });

		const firstTail = (await harness.invokeTool("ci_wait_tail", { jobId })) as AgentToolResult<{
			entries: { seq: number; progress: unknown }[];
			cursor: number;
		}>;
		expect(firstTail.details.entries.map((e) => e.progress)).toEqual([{ status: "queued" }, { status: "in_progress" }]);
		expect(firstTail.details.cursor).toBe(2);

		wait.tick({ status: "in_progress" }); // identical to the last tick -- default "transition" notify mode dedups it
		const secondTail = (await harness.invokeTool("ci_wait_tail", {
			jobId,
			cursor: firstTail.details.cursor,
		})) as AgentToolResult<{ entries: unknown[]; cursor: number }>;
		expect(secondTail.details.entries).toEqual([]);
		expect(secondTail.details.cursor).toBe(2);

		wait.succeed({ status: "success" });
		await harness.shutdown();
	});

	it("ci_wait_cancel stops a still-running watch instead of waiting it out", async () => {
		const { harness, wait } = harnessWithJobBackedCiWait();
		await harness.boot();

		const submitted = (await harness.invokeTool("ci_wait_submit", { runId: "42" })) as AgentToolResult<{ jobId: string }>;
		const jobId = submitted.details.jobId;
		await wait.started;

		await harness.invokeTool("ci_wait_cancel", { jobId });
		// The store's own AbortController fires synchronously; finalize() runs off the handler's
		// rejection once it actually observes the abort -- simulate that observation here since
		// this fixture's handler doesn't itself read the signal.
		wait.fail(new Error("aborted"));
		await Promise.resolve();
		await Promise.resolve();

		const poll = (await harness.invokeTool("ci_wait_poll", { jobId })) as AgentToolResult<{
			status: string;
			terminationReason?: string;
		}>;
		expect(poll.details.status).toBe("canceled");
		expect(poll.details.terminationReason).toBe("canceled");

		await harness.shutdown();
	});
});
