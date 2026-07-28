import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildSecretsMenuItems,
	buildServiceDetailItems,
	buildServicesMenuItems,
	decodeSecretMenuValue,
	describeExpiry,
	describeSecret,
	describeService,
	encodeSecretMenuValue,
	loadAllSecrets,
	performRevoke,
	performRotate,
	registerSecretsCommand,
	runSecretsCommand,
	SecretsBackendListError,
	SECRETS_MENU,
	SERVICES_MENU,
	type PickFromList,
	type SecretsMenuAction,
} from "../src/secrets-tui.ts";
import type { SecretRecord, SecretsBackend, ServiceRecord } from "../src/secrets-backend.ts";

// ── Pure descriptions -- state in, string out, no I/O, no pick ─────────────

describe("describeExpiry", () => {
	it("no expiresAt at all", () => {
		expect(describeExpiry(undefined)).toBe("no expiry");
	});

	it("an unparseable date string", () => {
		expect(describeExpiry("not-a-date")).toBe("no expiry");
	});

	it("already expired", () => {
		expect(describeExpiry(new Date(Date.now() - 1000).toISOString())).toBe("expired");
	});

	it("under an hour away", () => {
		expect(describeExpiry(new Date(Date.now() + 30_000).toISOString())).toBe("expires in <1h");
	});

	it("hours away", () => {
		expect(describeExpiry(new Date(Date.now() + 5 * 3_600_000).toISOString())).toBe("expires in 5h");
	});

	it("days away", () => {
		expect(describeExpiry(new Date(Date.now() + 5 * 86_400_000).toISOString())).toBe("expires in 5d");
	});
});

describe("describeSecret", () => {
	it("undefined record", () => {
		expect(describeSecret(undefined)).toBe("not configured");
	});

	it("not configured", () => {
		expect(describeSecret({ name: "github", source: "local", configured: false })).toBe("not configured");
	});

	it("configured, no expiry, no scope", () => {
		expect(describeSecret({ name: "github", source: "local", configured: true })).toBe("no expiry");
	});

	it("configured with a scope appends it", () => {
		expect(describeSecret({ name: "github", source: "local", configured: true, scope: "repo" })).toBe("no expiry \u2022 scope: repo");
	});
});

describe("describeService", () => {
	it("every backend configured", () => {
		const service: ServiceRecord = { name: "pipes", backends: ["github", "jenkins-ci"] };
		expect(describeService(service, new Set(["github", "jenkins-ci"]))).toBe("2 backends");
	});

	it("singular 'backend' for exactly one", () => {
		expect(describeService({ name: "pipes", backends: ["github"] }, new Set(["github"]))).toBe("1 backend");
	});

	it("flags unconfigured backends by count", () => {
		expect(describeService({ name: "pipes", backends: ["github", "jenkins-ci"] }, new Set(["github"]))).toBe("2 backends \u2022 1 unconfigured");
	});

	it("appends a bound uid when present", () => {
		expect(describeService({ name: "tickets", backends: ["github"], uid: 1001 }, new Set(["github"]))).toBe("1 backend \u2022 uid 1001");
	});
});

// ── Pure menu-value encoding ─────────────────────────────────────────────

describe("encodeSecretMenuValue / decodeSecretMenuValue", () => {
	it("round-trips source and name", () => {
		expect(decodeSecretMenuValue(encodeSecretMenuValue("local", "github"))).toEqual({ source: "local", name: "github" });
	});

	it("decodes undefined for a value with no separator at all", () => {
		expect(decodeSecretMenuValue("garbage")).toBeUndefined();
	});

	it("decodes undefined for a value missing its name half", () => {
		expect(decodeSecretMenuValue(encodeSecretMenuValue("local", ""))).toBeUndefined();
	});
});

// ── Pure item builders -- state in, SelectItem[] out ────────────────────────

function record(name: string, source: string, overrides: Partial<SecretRecord> = {}): SecretRecord {
	return { name, source, configured: true, ...overrides };
}

function backendStub(source: string): SecretsBackend {
	return { source, list: async () => [], get: async () => undefined, rotate: async () => {}, revoke: async () => {} };
}

describe("buildSecretsMenuItems", () => {
	it("one item per entry, keyed by source+name, labeled '<name> (<source>)'", () => {
		const items = buildSecretsMenuItems([{ backend: backendStub("local"), record: record("github", "local") }], []);
		expect(items).toEqual([{ value: "local\u0000github", label: "github (local)", description: "no expiry" }]);
	});

	it("appends extraActions after every real entry, in order", () => {
		const action: SecretsMenuAction = { value: "__login__", label: "+ Log in", run: async () => {} };
		const items = buildSecretsMenuItems([], [action]);
		expect(items).toEqual([{ value: "__login__", label: "+ Log in", description: undefined }]);
	});

	it("two backends holding the same record name don't collide -- distinct encoded values", () => {
		const items = buildSecretsMenuItems(
			[
				{ backend: backendStub("local"), record: record("github", "local") },
				{ backend: backendStub("enigma"), record: record("github", "enigma") },
			],
			[],
		);
		expect(items.map((i) => i.value)).toEqual(["local\u0000github", "enigma\u0000github"]);
	});
});

describe("buildServicesMenuItems", () => {
	it("one item per service, described against the given secret-name set", () => {
		const items = buildServicesMenuItems([{ name: "pipes", backends: ["github"] }], new Set(["github"]));
		expect(items).toEqual([{ value: "pipes", label: "pipes", description: "1 backend" }]);
	});
});

describe("buildServiceDetailItems", () => {
	it("one item per backend the service references, plus a trailing Back", () => {
		const service: ServiceRecord = { name: "pipes", backends: ["github", "jenkins-ci"] };
		const items = buildServiceDetailItems(service, new Map([["github", record("github", "local")]]));
		expect(items).toEqual([
			{ value: "github", label: "github", description: "no expiry" },
			{ value: "jenkins-ci", label: "jenkins-ci", description: "not configured anywhere" },
			{ value: "back", label: "Back" },
		]);
	});
});

// ── loadAllSecrets: aggregation + error attribution, no pick involved ──────

describe("loadAllSecrets", () => {
	it("flattens every backend's records, source paired with each", async () => {
		const a: SecretsBackend = { ...backendStub("local"), list: async () => [record("github", "local")] };
		const b: SecretsBackend = { ...backendStub("env"), list: async () => [record("github", "env")] };
		const entries = await loadAllSecrets([a, b]);
		expect(entries.map((e) => [e.backend.source, e.record.name])).toEqual([
			["local", "github"],
			["env", "github"],
		]);
	});

	it("wraps a backend's list() failure in SecretsBackendListError naming that backend", async () => {
		const failing: SecretsBackend = { ...backendStub("enigma"), list: async () => Promise.reject(new Error("HTTP 500")) };
		await expect(loadAllSecrets([failing])).rejects.toThrow(SecretsBackendListError);
		await expect(loadAllSecrets([failing])).rejects.toThrow("enigma: HTTP 500");
	});
});

// ── Mutating actions -- directly callable, no pick() sequence needed at all ──

function fakeCtx(overrides: { confirm?: boolean; hasUI?: boolean } = {}): { ctx: ExtensionCommandContext; notifications: Array<{ text: string; level: string }> } {
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		hasUI: overrides.hasUI ?? true,
		mode: "tui",
		ui: {
			notify: (text: string, level: string) => notifications.push({ text, level }),
			confirm: async () => overrides.confirm ?? true,
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

describe("performRotate", () => {
	it("calls backend.rotate and notifies success", async () => {
		const { ctx, notifications } = fakeCtx();
		const rotated: string[] = [];
		const backend: SecretsBackend = { ...backendStub("local"), rotate: async (name) => void rotated.push(name) };
		await performRotate(ctx, backend, "github");
		expect(rotated).toEqual(["github"]);
		expect(notifications).toEqual([{ text: "github: rotated.", level: "info" }]);
	});

	it("notifies an error, never throwing, when rotate() rejects", async () => {
		const { ctx, notifications } = fakeCtx();
		const backend: SecretsBackend = { ...backendStub("local"), rotate: async () => Promise.reject(new Error("no refresh configured")) };
		await performRotate(ctx, backend, "github");
		expect(notifications).toEqual([{ text: "github: rotate failed (no refresh configured)", level: "error" }]);
	});
});

describe("performRevoke", () => {
	it("returns false and never calls revoke() when the confirmation is declined", async () => {
		const { ctx } = fakeCtx({ confirm: false });
		const revoked: string[] = [];
		const backend: SecretsBackend = { ...backendStub("local"), revoke: async (name) => void revoked.push(name) };
		expect(await performRevoke(ctx, backend, "github")).toBe(false);
		expect(revoked).toEqual([]);
	});

	it("returns true, calls revoke(), and notifies success when confirmed", async () => {
		const { ctx, notifications } = fakeCtx({ confirm: true });
		const revoked: string[] = [];
		const backend: SecretsBackend = { ...backendStub("local"), revoke: async (name) => void revoked.push(name) };
		expect(await performRevoke(ctx, backend, "github")).toBe(true);
		expect(revoked).toEqual(["github"]);
		expect(notifications).toEqual([{ text: "github: revoked.", level: "info" }]);
	});

	it("returns false and notifies an error when revoke() rejects", async () => {
		const { ctx, notifications } = fakeCtx({ confirm: true });
		const backend: SecretsBackend = { ...backendStub("local"), revoke: async () => Promise.reject(new Error("disk full")) };
		expect(await performRevoke(ctx, backend, "github")).toBe(false);
		expect(notifications).toEqual([{ text: "github: revoke failed (disk full)", level: "error" }]);
	});

	it("skips confirm() entirely and returns false when ctx.hasUI is false", async () => {
		const { ctx } = fakeCtx({ hasUI: false });
		const backend: SecretsBackend = { ...backendStub("local") };
		expect(await performRevoke(ctx, backend, "github")).toBe(false);
	});
});

// ── Thin wiring smoke tests -- one or two per shape, not exhaustive chains ──

describe("runSecretsCommand: wiring smoke tests", () => {
	it("[secrets]-only mode (no ServicesRegistry): shows the merged item list built by buildSecretsMenuItems", async () => {
		const backend: SecretsBackend = { ...backendStub("local"), list: async () => [record("github", "local")] };
		let seenItems: unknown;
		const pick: PickFromList = async (_ctx, _title, items) => {
			seenItems = items;
			return null;
		};
		const { ctx } = fakeCtx();
		await runSecretsCommand(ctx, { backends: [backend], pick });
		expect(seenItems).toEqual(buildSecretsMenuItems([{ backend, record: record("github", "local") }], []));
	});

	it("with a ServicesRegistry: top-level menu is exactly TOP_LEVEL_MENU_ITEMS, selecting [services] enters buildServicesMenuItems' output", async () => {
		const { ctx } = fakeCtx();
		const registry = { list: async () => [{ name: "pipes", backends: ["github"] }] };
		const seenMenus: unknown[] = [];
		let calls = 0;
		const pick: PickFromList = async (_ctx, _title, items) => {
			seenMenus.push(items);
			calls += 1;
			return calls === 1 ? SERVICES_MENU : null;
		};
		await runSecretsCommand(ctx, { backends: [], servicesRegistry: registry, pick });
		expect(seenMenus[1]).toEqual(buildServicesMenuItems([{ name: "pipes", backends: ["github"] }], new Set()));
	});

	it("a backend's list() failing mid-session notifies which backend failed, without an uncaught throw", async () => {
		const { ctx, notifications } = fakeCtx();
		const failing: SecretsBackend = { ...backendStub("enigma"), list: async () => Promise.reject(new Error("HTTP 500")) };
		await expect(runSecretsCommand(ctx, { backends: [failing], pick: async () => null })).resolves.toBeUndefined();
		expect(notifications).toEqual([{ text: 'Could not reach the "enigma" backend: HTTP 500', level: "error" }]);
	});

	it("extraActions run() is invoked when its value is selected from the [secrets] menu", async () => {
		const { ctx } = fakeCtx();
		const ran: string[] = [];
		const action: SecretsMenuAction = { value: "__login__", label: "+ Log in", run: async () => void ran.push("login") };
		let calls = 0;
		const pick: PickFromList = async () => {
			calls += 1;
			return calls === 1 ? "__login__" : null;
		};
		await runSecretsCommand(ctx, { backends: [], extraActions: [action], pick });
		expect(ran).toEqual(["login"]);
	});

	it("notifies instead of opening a menu when there are no secrets and no extraActions", async () => {
		const { ctx, notifications } = fakeCtx();
		await runSecretsCommand(ctx, { backends: [backendStub("local")], pick: async () => null });
		expect(notifications[0]?.text).toContain("No secrets known");
	});
});

describe("registerSecretsCommand", () => {
	it("registers under 'secrets' by default", () => {
		const registered: Array<{ name: string; description: string }> = [];
		const pi = { registerCommand: (name: string, def: { description: string }) => registered.push({ name, description: def.description }) } as unknown as ExtensionAPI;
		registerSecretsCommand(pi, () => ({ backends: [] }));
		expect(registered).toEqual([{ name: "secrets", description: "Manage credentials: view status, rotate, or revoke, across every configured backend" }]);
	});

	it("registers under a caller-supplied name instead, so a second daemon-kit consumer in the same Pi session doesn't collide with an existing /secrets", () => {
		const registered: string[] = [];
		const pi = { registerCommand: (name: string) => registered.push(name) } as unknown as ExtensionAPI;
		registerSecretsCommand(pi, () => ({ backends: [] }), "tickets-secrets");
		expect(registered).toEqual(["tickets-secrets"]);
	});
});
