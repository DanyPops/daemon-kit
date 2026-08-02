import { describe, expect, it } from "bun:test";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { registerWorkOperations, runWork } from "../src/extension.ts";

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 100));
}

describe("job-orchestration template", () => {
	it("runWork returns a real result for its input", async () => {
		const result = await runWork({ topic: "vehicle templates" });
		expect(result.topic).toBe("vehicle templates");
		expect(result.result).toContain("vehicle templates");
	});

	it("registers work.run, work.submit, and work.poll", () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.0.0", description: "test" });
		registerWorkOperations(registry);
		const names = registry.manifest().operations.map((op) => op.name).sort();
		expect(names).toEqual(["work.poll", "work.run", "work.submit"]);
	});

	it("work.submit returns a job id immediately; work.poll eventually reports it succeeded with the real result", async () => {
		const registry = new VehicleRegistry({ name: "test", version: "1.0.0", description: "test" });
		registerWorkOperations(registry);

		const submitted = (await registry.invoke("work.submit", 1, { topic: "background jobs" })) as { jobId: string };
		expect(submitted.jobId).toBeTruthy();

		await flush();

		const polled = (await registry.invoke("work.poll", 1, { jobId: submitted.jobId })) as {
			status: string;
			output?: { topic: string; result: string };
		};
		expect(polled.status).toBe("succeeded");
		expect(polled.output?.topic).toBe("background jobs");
	});
});
