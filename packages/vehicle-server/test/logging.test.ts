import { describe, expect, it } from "bun:test";
import { createLogger } from "../src/logging.ts";

function capture() {
	const lines: string[] = [];
	return {
		lines,
		destination: {
			write: (chunk: string) => {
				lines.push(chunk);
				return true;
			},
		},
	};
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

	describe("redact", () => {
		it("censors a credential-shaped field logged at the root, in the actual serialized output", () => {
			const { lines, destination } = capture();
			const logger = createLogger("m", { level: "debug", destination });
			logger.info("login", { token: "super-secret-value", userId: 42 });
			const parsed = JSON.parse(lines[0]!);
			expect(parsed.token).toBe("[REDACTED]");
			expect(parsed.userId).toBe(42);
		});

		it("censors every default credential-shaped field name, at the root", () => {
			const { lines, destination } = capture();
			const logger = createLogger("m", { level: "debug", destination });
			const fields = {
				password: "x",
				token: "x",
				accessToken: "x",
				refreshToken: "x",
				apiKey: "x",
				secret: "x",
				authorization: "x",
				credential: "x",
			};
			logger.info("m", fields);
			const parsed = JSON.parse(lines[0]!);
			for (const key of Object.keys(fields)) expect(parsed[key], `${key} was not redacted`).toBe("[REDACTED]");
		});

		it("censors a credential-shaped field nested one level deep, via the default *.<field> wildcard paths", () => {
			const { lines, destination } = capture();
			const logger = createLogger("m", { level: "debug", destination });
			logger.info("m", { user: { token: "super-secret-value", id: 1 } });
			const parsed = JSON.parse(lines[0]!);
			expect(parsed.user.token).toBe("[REDACTED]");
			expect(parsed.user.id).toBe(1);
		});

		it("never touches a field whose name doesn't match any redact path", () => {
			const { lines, destination } = capture();
			const logger = createLogger("m", { level: "debug", destination });
			logger.info("m", { username: "alice", tokenCount: 3 });
			const parsed = JSON.parse(lines[0]!);
			expect(parsed.username).toBe("alice");
			expect(parsed.tokenCount).toBe(3);
		});

		it("additionalRedactPaths appends to, rather than replaces, the shared default list", () => {
			const { lines, destination } = capture();
			const logger = createLogger("m", { level: "debug", destination, additionalRedactPaths: ["packageCredential"] });
			logger.info("m", { packageCredential: "x", token: "y" });
			const parsed = JSON.parse(lines[0]!);
			expect(parsed.packageCredential).toBe("[REDACTED]");
			expect(parsed.token, "the default list must still apply alongside a consumer's own extra paths").toBe("[REDACTED]");
		});

		it("a consumer that passes no additionalRedactPaths sees exactly the default list's behavior -- no behavior change", () => {
			const { lines, destination } = capture();
			const logger = createLogger("m", { level: "debug", destination });
			logger.info("m", { token: "x", somethingElse: "y" });
			const parsed = JSON.parse(lines[0]!);
			expect(parsed.token).toBe("[REDACTED]");
			expect(parsed.somethingElse).toBe("y");
		});
	});
});
