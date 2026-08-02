import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHandleReadinessProbe, replaceFileAtomically } from "../src/index.js";
import { vehicle } from "./fixtures.js";

describe("native runtime primitives", () => {
	it("replaces descriptor files atomically without leaving temporary files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "armada-descriptor-"));
		const path = join(directory, "armada-papyrus.service");
		expect((await replaceFileAtomically(path, "first\n")).ok).toBe(true);
		expect((await replaceFileAtomically(path, "second\n")).ok).toBe(true);
		expect(await readFile(path, "utf8")).toBe("second\n");
		expect(await readdir(directory)).toEqual(["armada-papyrus.service"]);
	});

	it("waits within the declared bound for a live loopback Vehicle handle", async () => {
		let now = 0;
		let reads = 0;
		const probe = createHandleReadinessProbe({
			now: () => now,
			sleep: (milliseconds) => {
				now += milliseconds;
				return Promise.resolve();
			},
			readHandle: () => {
				reads++;
				return Promise.resolve(reads === 1 ? undefined : { host: "127.0.0.1", port: 4312, pid: 42 });
			},
			isPidAlive: (pid) => pid === 42,
		});
		const outcome = await probe.waitUntilReady(vehicle({ readiness: { timeoutMs: 500, pollIntervalMs: 100 } }));
		expect(outcome).toEqual({ ok: true, diagnostics: [] });
		expect(now).toBe(100);
	});

	it("times out on malformed, non-loopback, or dead handles", async () => {
		for (const handle of [
			{ host: "0.0.0.0", port: 4312, pid: 42 },
			{ host: "127.0.0.1", port: 0, pid: 42 },
			{ host: "127.0.0.1", port: 4312, pid: 99 },
		]) {
			let now = 0;
			const probe = createHandleReadinessProbe({
				now: () => now,
				sleep: (milliseconds) => {
					now += milliseconds;
					return Promise.resolve();
				},
				readHandle: () => Promise.resolve(handle),
				isPidAlive: (pid) => pid === 42,
			});
			const outcome = await probe.waitUntilReady(vehicle({ readiness: { timeoutMs: 200, pollIntervalMs: 100 } }));
			expect(outcome).toMatchObject({ ok: false, diagnostics: [{ code: "VEHICLE_READINESS_TIMEOUT" }] });
			expect(now).toBe(200);
		}
	});
});
