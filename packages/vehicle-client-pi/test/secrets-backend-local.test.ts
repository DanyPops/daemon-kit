import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "@danypops/vehicle-server/vault";
import { createLocalSecretsBackend } from "../src/secrets-backend-local.ts";
import { SecretsBackendUnsupportedOperationError } from "../src/secrets-backend.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "daemon-kit-secrets-local-"));
}

describe("createLocalSecretsBackend: plaintext", () => {
	it("list() returns [] against a directory that doesn't exist yet, not an error", async () => {
		const dir = join(tmpDir(), "missing");
		const backend = createLocalSecretsBackend({ dir });
		expect(await backend.list()).toEqual([]);
	});

	it("list() enumerates every *.json file in the directory as its own record", async () => {
		const dir = tmpDir();
		try {
			createFileStore(dir, "github").save({ accessToken: "gh", scope: "repo" });
			createFileStore(dir, "jenkins-ci").save({ accessToken: "jk" });
			const records = await createLocalSecretsBackend({ dir }).list();
			expect(records.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
				{ name: "github", source: "local", configured: true, scope: "repo" },
				{ name: "jenkins-ci", source: "local", configured: true },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("get() resolves undefined for a name with no backing file -- unlike env, a local name's existence IS the file", async () => {
		const dir = tmpDir();
		try {
			const record = await createLocalSecretsBackend({ dir }).get("github");
			expect(record).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("get() surfaces expiresAt from the stored token", async () => {
		const dir = tmpDir();
		try {
			const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
			createFileStore(dir, "gitlab").save({ accessToken: "gl", expiresAt });
			expect(await createLocalSecretsBackend({ dir }).get("gitlab")).toEqual({ name: "gitlab", source: "local", configured: true, expiresAt });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("revoke() deletes the backing file", async () => {
		const dir = tmpDir();
		try {
			createFileStore(dir, "github").save({ accessToken: "gh" });
			const path = join(dir, "github.json");
			expect(existsSync(path)).toBe(true);
			await createLocalSecretsBackend({ dir }).revoke("github");
			expect(existsSync(path)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("revoke() on a name with no file is a no-op, not a throw", async () => {
		const dir = tmpDir();
		try {
			await expect(createLocalSecretsBackend({ dir }).revoke("nonexistent")).resolves.toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rotate() always throws SecretsBackendUnsupportedOperationError -- no generic re-auth mechanism exists", async () => {
		const dir = tmpDir();
		try {
			await expect(createLocalSecretsBackend({ dir }).rotate("github")).rejects.toThrow(SecretsBackendUnsupportedOperationError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("source is 'local'", () => {
		expect(createLocalSecretsBackend({ dir: tmpDir() }).source).toBe("local");
	});

	it("reveal() returns the full stored token, unredacted", async () => {
		const dir = tmpDir();
		try {
			createFileStore(dir, "github").save({ accessToken: "gh_real_value", refreshToken: "refresh_real_value", scope: "repo" });
			expect(await createLocalSecretsBackend({ dir }).reveal("github")).toEqual({ accessToken: "gh_real_value", refreshToken: "refresh_real_value", scope: "repo" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reveal() resolves undefined for a name with no backing file", async () => {
		const dir = tmpDir();
		try {
			expect(await createLocalSecretsBackend({ dir }).reveal("nonexistent")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createLocalSecretsBackend: encrypted", () => {
	it("round-trips through an encrypted store when masterKey is given, transparent to the port's caller", async () => {
		const dir = tmpDir();
		try {
			const masterKey = randomBytes(32);
			const { createEncryptedFileStore } = await import("@danypops/vehicle-server/vault");
			createEncryptedFileStore({ dir, masterKey }, "jira").save({ accessToken: "j", extra: { cloudId: "x" } });
			expect(await createLocalSecretsBackend({ dir, masterKey }).get("jira")).toEqual({ name: "jira", source: "local", configured: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reveal() decrypts and returns the full stored token, transparent to the port's caller", async () => {
		const dir = tmpDir();
		try {
			const masterKey = randomBytes(32);
			const { createEncryptedFileStore } = await import("@danypops/vehicle-server/vault");
			createEncryptedFileStore({ dir, masterKey }, "jira").save({ accessToken: "j_real_value", extra: { cloudId: "x" } });
			expect(await createLocalSecretsBackend({ dir, masterKey }).reveal("jira")).toEqual({ accessToken: "j_real_value", extra: { cloudId: "x" } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
