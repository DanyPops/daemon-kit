/**
 * registerVehicleToolsWhenReady's retry loop (vehicle-pi.ts's `attempt`) captures one
 * ExtensionContext at session_start and reuses it across every retry, including across the
 * `await sleep(...)` between attempts. Real Pi invalidates a captured ctx once its session is
 * replaced or reloaded (see extensions.md's "Session replacement lifecycle and footguns"); a
 * consumer's `log` callback reading event.ctx.ui on a later event (e.g. pi-tickets'
 * notifyReadyEvent on "exhausted") then throws. `attempt` never guards its own `options.log?.()`
 * calls and is invoked fire-and-forget (`void attempt(1, ctx)`), so that throw escapes as an
 * unhandled rejection -- which crashes the whole host process, not just this one registration.
 * Live-observed incident: exactly this path, through pi-tickets' registerTicketsVehicle.
 *
 * Confirmed in-process (bun:test, same file as vehicle-pi-ready.test.ts) that this specific
 * failure doesn't just fail the one test -- an uncaught exception surfacing while the test is
 * suspended on `await` past the point where it fired stops the whole test file from completing.
 * Runs in a real subprocess instead, built on the same shared @danypops/pi-extension-harness
 * every other test in this suite uses (not a hand-rolled fake ctx/pi) -- ctx staleness is
 * simulated via the harness's own invalidateCtx(), added in pi-extension-harness 0.6.1
 * specifically to make this footgun class testable without everyone re-inventing a fake.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE_BODY = `
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { registerVehicleToolsWhenReady } from ${JSON.stringify(join(PACKAGE_ROOT, "src", "vehicle-pi.ts"))};

const harness = createExtensionHarness(() => {});
const events = [];

// Mirrors pi-tickets' real notifyReadyEvent: quiet on the common still-starting case, notifies
// on the terminal "exhausted" outcome.
function notifyReadyEvent(event) {
	events.push(event.kind);
	if (event.kind === "exhausted") {
		event.ctx.ui.notify(\`tools unavailable after \${event.attempts} attempts\`, "warning");
	}
}

registerVehicleToolsWhenReady(harness.api, () => Promise.resolve(undefined), {
	retry: { attempts: 2, initialDelayMs: 10, maxDelayMs: 10 },
	log: notifyReadyEvent,
});

await harness.emit("session_start");
// Simulates a session replacement/reload landing between attempt 1 and attempt 2.
harness.invalidateCtx();

setTimeout(() => console.log("REACHED_END_WITHOUT_CRASHING:" + events.join(",")), 300);
`;

function writeFixture(): string {
	const dir = mkdtempSync(join(PACKAGE_ROOT, ".session-replacement-crash-"));
	dirs.push(dir);
	const path = join(dir, "repro.mjs");
	writeFileSync(path, FIXTURE_BODY);
	return path;
}

/** Real Pi hosts run this package under Bun (the live incident's own stack was rooted under
 * .cache/.bun) -- runs the fixture the same way, cwd'd to the package root so its relative
 * ../src import and node_modules (including @danypops/pi-extension-harness itself) resolve. */
function runUnderBun(scriptPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn("bun", ["run", scriptPath], { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

// A session replaced/reloaded mid-retry must not crash the host: a log() callback touching a
// now-stale ctx.ui on the exhausted event must be caught, not an uncaught process-killing rejection.
describe("registerVehicleToolsWhenReady across a session replacement mid-retry", () => {
	it("a log() callback touching a now-stale ctx.ui is caught, not an uncaught rejection", async () => {
		const result = await runUnderBun(writeFixture());

		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("Uncaught");
		expect(result.stdout).toContain("REACHED_END_WITHOUT_CRASHING:client-unavailable,client-unavailable,exhausted");
	}, 15_000);
});
