import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runSecretsCommand, type PickFromList } from "../src/secrets-tui.ts";
import type { SecretRecord, SecretsBackend, ServiceRecord, ServicesRegistry } from "../src/secrets-backend.ts";

function fakeCtx(overrides: { confirm?: boolean; hasUI?: boolean } = {}): { ctx: ExtensionCommandContext; notifications: Array<{ text: string; level: string }> } {
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		hasUI: overrides.hasUI ?? true,
		mode: "tui",
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
			confirm: async () => overrides.confirm ?? true,
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

/** Scripted `pick`: returns each queued value in order, then null forever after. */
function scriptedPick(...values: Array<string | null>): PickFromList {
	const queue = [...values];
	return async () => (queue.length > 0 ? queue.shift()! : null);
}

function fakeBackend(source: string, records: Record<string, SecretRecord>): SecretsBackend & { rotated: string[]; revoked: string[] } {
	const backend = {
		source,
		rotated: [] as string[],
		revoked: [] as string[],
		list: async () => Object.values(records),
		get: async (name: string) => records[name],
		rotate: async (name: string) => {
			backend.rotated.push(name);
		},
		revoke: async (name: string) => {
			backend.revoked.push(name);
			delete records[name];
		},
	};
	return backend;
}

describe("runSecretsCommand: no ServicesRegistry -- [secrets]-only mode", () => {
	it("notifies instead of opening a menu when there are no secrets across any backend", async () => {
		const { ctx, notifications } = fakeCtx();
		await runSecretsCommand(ctx, { backends: [fakeBackend("local", {})], pick: scriptedPick() });
		expect(notifications[0]?.text).toContain("No secrets known");
	});

	it("lists every record from every backend in one merged menu", async () => {
		const { ctx } = fakeCtx();
		const local = fakeBackend("local", { github: { name: "github", source: "local", configured: true } });
		const env = fakeBackend("env", { jira: { name: "jira", source: "env", configured: false } });
		const seen: string[][] = [];
		const pick: PickFromList = async (_ctx, _title, items) => {
			seen.push(items.map((i) => i.label));
			return null;
		};
		await runSecretsCommand(ctx, { backends: [local, env], pick });
		expect(seen[0]).toEqual(["github (local)", "jira (env)"]);
	});

	it("rotate calls through to the owning backend, keyed by source -- not just by name", async () => {
		const { ctx, notifications } = fakeCtx();
		const local = fakeBackend("local", { github: { name: "github", source: "local", configured: true } });
		const pick = scriptedPick("local\u0000github", "rotate", "back", null);
		await runSecretsCommand(ctx, { backends: [local], pick });
		expect(local.rotated).toEqual(["github"]);
		expect(notifications.some((n) => n.text.includes("rotated"))).toBe(true);
	});

	it("revoke asks for confirmation and calls through on yes", async () => {
		const { ctx, notifications } = fakeCtx({ confirm: true });
		const local = fakeBackend("local", { github: { name: "github", source: "local", configured: true } });
		const pick = scriptedPick("local\u0000github", "revoke");
		await runSecretsCommand(ctx, { backends: [local], pick });
		expect(local.revoked).toEqual(["github"]);
		expect(notifications.some((n) => n.text.includes("revoked"))).toBe(true);
	});

	it("revoke does nothing when confirmation is declined", async () => {
		const { ctx } = fakeCtx({ confirm: false });
		const local = fakeBackend("local", { github: { name: "github", source: "local", configured: true } });
		const pick = scriptedPick("local\u0000github", "revoke", "back", null);
		await runSecretsCommand(ctx, { backends: [local], pick });
		expect(local.revoked).toEqual([]);
	});

	it("surfaces a rotate failure via notify instead of throwing out of the command", async () => {
		const { ctx, notifications } = fakeCtx();
		const failing: SecretsBackend = {
			source: "local",
			list: async () => [{ name: "github", source: "local", configured: true }],
			get: async () => ({ name: "github", source: "local", configured: true }),
			rotate: async () => {
				throw new Error("network unreachable");
			},
			revoke: async () => {},
		};
		const pick = scriptedPick("local\u0000github", "rotate", "back", null);
		await runSecretsCommand(ctx, { backends: [failing], pick });
		expect(notifications.some((n) => n.level === "error" && n.text.includes("network unreachable"))).toBe(true);
	});
});

describe("runSecretsCommand: a backend's list() failing mid-session", () => {
	it("[secrets] menu: notifies which backend failed and returns, instead of an uncaught throw", async () => {
		const { ctx, notifications } = fakeCtx();
		const failing: SecretsBackend = {
			source: "enigma",
			list: async () => {
				throw new Error("vault request failed: GET /keys: HTTP 500");
			},
			get: async () => undefined,
			rotate: async () => {},
			revoke: async () => {},
		};
		await expect(runSecretsCommand(ctx, { backends: [failing], pick: scriptedPick() })).resolves.toBeUndefined();
		expect(notifications).toEqual([{ text: 'Could not reach the "enigma" backend: vault request failed: GET /keys: HTTP 500', level: "error" }]);
	});

	it("[services] menu: same failure while resolving cross-referenced secret status also notifies and returns cleanly", async () => {
		const { ctx, notifications } = fakeCtx();
		const failing: SecretsBackend = {
			source: "local",
			list: async () => {
				throw new Error("ENOENT");
			},
			get: async () => undefined,
			rotate: async () => {},
			revoke: async () => {},
		};
		const registry: ServicesRegistry = { list: async () => [{ name: "pipes", backends: ["github"] }] };
		const pick = scriptedPick("__daemon_kit_secrets_services_menu__", null);
		await expect(runSecretsCommand(ctx, { backends: [failing], servicesRegistry: registry, pick })).resolves.toBeUndefined();
		expect(notifications).toEqual([{ text: 'Could not reach the "local" backend: ENOENT', level: "error" }]);
	});
});

describe("runSecretsCommand: extraActions", () => {
	it("appends a caller-supplied action to the [secrets] menu and runs it on selection, distinct from any real secret", async () => {
		const { ctx } = fakeCtx();
		const local = fakeBackend("local", { github: { name: "github", source: "local", configured: true } });
		const ran: string[] = [];
		const pick = scriptedPick("__login__", null);
		await runSecretsCommand(ctx, {
			backends: [local],
			extraActions: [{ value: "__login__", label: "+ Log in a backend", run: async () => void ran.push("login") }],
			pick,
		});
		expect(ran).toEqual(["login"]);
	});

	it("shows extraActions even when there are zero real secrets, instead of short-circuiting to a notify", async () => {
		const { ctx, notifications } = fakeCtx();
		const empty = fakeBackend("local", {});
		const seen: string[][] = [];
		const pick: PickFromList = async (_ctx, _title, items) => {
			seen.push(items.map((i) => i.label));
			return null;
		};
		await runSecretsCommand(ctx, { backends: [empty], extraActions: [{ value: "__login__", label: "+ Log in a backend", run: async () => {} }], pick });
		expect(seen[0]).toEqual(["+ Log in a backend"]);
		expect(notifications).toEqual([]);
	});
});

describe("runSecretsCommand: with a ServicesRegistry -- two-menu mode", () => {
	function fakeRegistry(services: ServiceRecord[]): ServicesRegistry {
		return { list: async () => services };
	}

	it("shows [services] and [secrets] as the top-level menu", async () => {
		const { ctx } = fakeCtx();
		const seen: string[][] = [];
		const pick: PickFromList = async (_ctx, _title, items) => {
			seen.push(items.map((i) => i.label));
			return null;
		};
		await runSecretsCommand(ctx, { backends: [], servicesRegistry: fakeRegistry([]), pick });
		expect(seen[0]).toEqual(["[services]", "[secrets]"]);
	});

	it("a service's own submenu shows which secrets it references, each with real configured status", async () => {
		const { ctx } = fakeCtx();
		const local = fakeBackend("local", { github: { name: "github", source: "local", configured: true } });
		const registry = fakeRegistry([{ name: "pipes", backends: ["github", "jenkins-ci"] }]);
		// Sequence: top menu -> [services], services list -> "pipes", service submenu -> back, services list -> back, top menu -> back.
		const pick = scriptedPick("__daemon_kit_secrets_services_menu__", "pipes", "back", null, null);
		let serviceSubmenuDescriptions: string[] = [];
		const spyPick: PickFromList = async (c, title, items, help) => {
			if (items.some((i) => i.value === "github")) serviceSubmenuDescriptions = items.map((i) => i.description ?? "");
			return pick(c, title, items, help);
		};
		await runSecretsCommand(ctx, { backends: [local], servicesRegistry: registry, pick: spyPick });
		expect(serviceSubmenuDescriptions).toEqual(["no expiry", "not configured anywhere", ""]); // trailing "" is the submenu's own "Back" entry
	});

	it("flags a service backend with no matching secret anywhere as unconfigured in its own description", async () => {
		const { ctx } = fakeCtx();
		const registry = fakeRegistry([{ name: "pipes", backends: ["github"] }]);
		// Navigate into [services] first -- the top-level menu's own items don't carry per-service descriptions.
		const pick = scriptedPick("__daemon_kit_secrets_services_menu__", null, null);
		const seen: string[][] = [];
		const spyPick: PickFromList = async (c, title, items, help) => {
			if (items.some((i) => i.value === "pipes")) seen.push(items.map((i) => i.description ?? ""));
			return pick(c, title, items, help);
		};
		await runSecretsCommand(ctx, { backends: [], servicesRegistry: registry, pick: spyPick });
		expect(seen.some((descs) => descs.some((d) => d.includes("1 unconfigured")))).toBe(true);
	});
});
