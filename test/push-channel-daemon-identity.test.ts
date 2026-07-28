/**
 * Regression test for "PushChannel has two nominally-incompatible identities
 * (raw src export vs. daemon's compiled dist import)": a consumer building
 * a PushChannel through this package's own public `./push-channel` export
 * (here, its resolved dist artifact -- exactly what a real npm consumer
 * gets) must be assignable to startDaemon()'s `pushChannel` option with no
 * cast. Before the fix, `./push-channel` resolved to raw src/push-channel.ts
 * while `./daemon`'s compiled dist/daemon.d.ts expected a PushChannel typed
 * against its own separately-compiled dist/push-channel.d.ts -- two
 * declaration sites for a class with private fields are nominally distinct
 * even when structurally identical, so TypeScript rejected the assignment
 * without an `as unknown as ...` cast. The type-level proof *is* this file
 * compiling clean under tsc --noEmit with no cast anywhere in it; the
 * runtime assertions below additionally prove the resulting daemon and
 * channel actually work together, not just type-check.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushChannel } from "../dist/push-channel.js";
import { startDaemon } from "../dist/daemon.js";

describe("PushChannel <-> startDaemon type identity", () => {
	it("a PushChannel built through the public export assigns to startDaemon's pushChannel option with no cast, and works end to end", async () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-push-identity-"));
		const pushChannel = new PushChannel({ token: "identity-check-token" });

		const daemon = await startDaemon({
			daemonLabel: "PushIdentityCheck",
			handlePath: join(dir, "handle.json"),
			buildApp: () => ({ async fetch() { return new Response("ok"); } }),
			pushChannel, // <-- the actual proof: no cast, no `as unknown as`, nothing.
		});
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/push?token=identity-check-token`);
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("timed out waiting for open")), 5_000);
				ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); });
			});
			ws.send(JSON.stringify({ op: "subscribe", topic: "identity" }));

			const messageArrived = new Promise<{ topic: string; payload: unknown }>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("timed out waiting for a push message")), 5_000);
				ws.addEventListener("message", (event) => {
					clearTimeout(timeout);
					resolve(JSON.parse(String(event.data)));
				}, { once: true });
			});
			// Give the subscribe control message a moment to be processed before publishing.
			await new Promise((resolve) => setTimeout(resolve, 50));
			pushChannel.publish("identity", { real: true });

			expect(await messageArrived).toEqual({ topic: "identity", payload: { real: true } });
			ws.close();
		} finally {
			await daemon.stop();
		}
	});
});
