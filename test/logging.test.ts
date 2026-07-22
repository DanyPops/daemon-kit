import { describe, expect, it } from "bun:test";
import { createLogger } from "../src/logging.ts";

function capture() {
	const lines: string[] = [];
	return { lines, destination: { write: (chunk: string) => { lines.push(chunk); return true; } } };
}

describe("createLogger", () => {
	it("emits a string level field (not pino's numeric default), the component, and the message", () => {
		const { lines, destination } = capture();
		const logger = createLogger("my-module", { level: "debug", destination });
		logger.info("hello", { userId: 42 });
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.level).toBe("info");
		expect(parsed.component).toBe("my-module");
		expect(parsed.msg).toBe("hello");
		expect(parsed.userId).toBe(42);
		expect(typeof parsed.timestamp).toBe("string");
	});

	it("filters below the configured minimum level", () => {
		const { lines, destination } = capture();
		const logger = createLogger("m", { level: "warn", destination });
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!).level).toBe("warn");
		expect(JSON.parse(lines[1]!).level).toBe("error");
	});

	it("reads the minimum level from an env var, defaulting to info for unset or garbage values", () => {
		const { lines, destination } = capture();
		const logger = createLogger("m", { levelEnvVar: "ACME_LOG_LEVEL", env: { ACME_LOG_LEVEL: "garbage" }, destination });
		logger.debug("d");
		logger.info("i");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).level).toBe("info");
	});

	it("an explicit level option takes precedence over the env var", () => {
		const { lines, destination } = capture();
		const logger = createLogger("m", { level: "debug", levelEnvVar: "ACME_LOG_LEVEL", env: { ACME_LOG_LEVEL: "error" }, destination });
		logger.debug("d");
		expect(lines).toHaveLength(1);
	});

	it("fields default to an empty object rather than throwing when omitted", () => {
		const { lines, destination } = capture();
		const logger = createLogger("m", { level: "debug", destination });
		expect(() => logger.info("no fields")).not.toThrow();
		expect(JSON.parse(lines[0]!).msg).toBe("no fields");
	});
});
