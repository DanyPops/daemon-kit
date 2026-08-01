import { describe, expect, it } from "bun:test";
import { SecretsBackendUnsupportedOperationError } from "../src/secrets-backend.ts";
import { createEnvSecretsBackend } from "../src/secrets-backend-env.ts";

describe("createEnvSecretsBackend", () => {
	it("lists every declared name, marking configured true only when its env var is actually set", async () => {
		const backend = createEnvSecretsBackend({ github: "GITHUB_TOKEN", jira: "JIRA_API_TOKEN" }, { GITHUB_TOKEN: "ghp_x" });
		expect(await backend.list()).toEqual([
			{ name: "github", source: "env", configured: true },
			{ name: "jira", source: "env", configured: false },
		]);
	});

	it("get() resolves a single declared name, undefined for anything not declared", async () => {
		const backend = createEnvSecretsBackend({ github: "GITHUB_TOKEN" }, { GITHUB_TOKEN: "ghp_x" });
		expect(await backend.get("github")).toEqual({ name: "github", source: "env", configured: true });
		expect(await backend.get("unknown")).toBeUndefined();
	});

	it("treats an empty-string env var as not configured, not merely present", async () => {
		const backend = createEnvSecretsBackend({ github: "GITHUB_TOKEN" }, { GITHUB_TOKEN: "" });
		expect(await backend.get("github")).toEqual({ name: "github", source: "env", configured: false });
	});

	it("rotate() and revoke() both throw SecretsBackendUnsupportedOperationError -- an env var isn't this process's to mutate", async () => {
		const backend = createEnvSecretsBackend({ github: "GITHUB_TOKEN" }, {});
		await expect(backend.rotate("github")).rejects.toThrow(SecretsBackendUnsupportedOperationError);
		await expect(backend.revoke("github")).rejects.toThrow(SecretsBackendUnsupportedOperationError);
	});

	it("source is 'env'", () => {
		expect(createEnvSecretsBackend({}).source).toBe("env");
	});

	it("reveal() returns the raw env var value for a configured name", async () => {
		const backend = createEnvSecretsBackend({ github: "GITHUB_TOKEN" }, { GITHUB_TOKEN: "ghp_real_value" });
		expect(await backend.reveal("github")).toEqual({ accessToken: "ghp_real_value" });
	});

	it("reveal() resolves undefined for an unconfigured or undeclared name, never throwing", async () => {
		const backend = createEnvSecretsBackend({ github: "GITHUB_TOKEN" }, {});
		expect(await backend.reveal("github")).toBeUndefined();
		expect(await backend.reveal("unknown")).toBeUndefined();
	});
});
