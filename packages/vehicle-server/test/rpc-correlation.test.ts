import { describe, expect, it } from "bun:test";
import { getCurrentRpcCallId, runWithRpcCallId } from "../src/rpc-correlation.ts";

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runWithRpcCallId / getCurrentRpcCallId", () => {
	it("returns undefined outside any bound call", () => {
		expect(getCurrentRpcCallId()).toBeUndefined();
	});

	it("makes the id readable from inside the bound function", () => {
		const seen = runWithRpcCallId("call-1", () => getCurrentRpcCallId());
		expect(seen).toBe("call-1");
	});

	it("survives several real awaits deep, simulating a real async handler chain", async () => {
		async function threeLevelsDeep(): Promise<string | undefined> {
			await flush();
			async function inner(): Promise<string | undefined> {
				await flush();
				await flush();
				return getCurrentRpcCallId();
			}
			return inner();
		}

		const seen = await runWithRpcCallId("deep-call", () => threeLevelsDeep());
		expect(seen).toBe("deep-call");
	});

	it("two concurrent calls each keep their own id, never leaking into the other", async () => {
		async function reportAfterDelay(delayMs: number): Promise<string | undefined> {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return getCurrentRpcCallId();
		}

		const [first, second] = await Promise.all([
			runWithRpcCallId("call-a", () => reportAfterDelay(15)),
			runWithRpcCallId("call-b", () => reportAfterDelay(5)),
		]);

		expect(first).toBe("call-a");
		expect(second).toBe("call-b");
		expect(first).not.toBe(second);
	});

	it("is undefined again once the bound function has returned", async () => {
		await runWithRpcCallId("call-1", async () => {
			await flush();
		});
		expect(getCurrentRpcCallId()).toBeUndefined();
	});
});
