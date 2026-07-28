/**
 * The `/secrets` Pi command, built against SecretsBackend/ServicesRegistry
 * instead of any one vendor's admin client -- Enigma is one pluggable
 * SecretsBackend among possibly several (env, local, Enigma), not the
 * assumed target. Any daemon-kit consumer gets a working two-menu secrets
 * command by passing its own backends/registry; no backend, no Enigma, and
 * this still works against whatever env/local backends were given.
 *
 * [secrets]: merged view across every given backend, rotate/revoke per
 * record. Registration/login is deliberately NOT modeled here -- each
 * backend's own auth flow (device flow, static token, ...) is too
 * backend-specific for this generic port; that stays in each consumer's
 * own CLI/extension (pipes login, tickets auth login, enigma login).
 *
 * [services]: only shown when a ServicesRegistry is supplied (optional --
 * a consumer with nothing service-registry-shaped skips straight to
 * [secrets]). Selecting a service shows which secrets it references
 * (already known: ServiceRecord.backends) and, new, which secrets have NO
 * service referencing them at all -- the reverse direction the flat
 * Enigma-only /secrets command never exposed.
 *
 * Deliberately decomposed per this project's TUI-testing rule (Lexicon
 * practices/tui-testing.md): every menu's item list and every mutating
 * action is its own pure/injectable function, testable by asserting on its
 * return value or its effect directly -- never by scripting a pick()
 * sequence through the whole command. The pick()-driven loops below exist
 * only to wire those pieces together; they carry no logic of their own
 * worth testing beyond a couple of thin end-to-end smoke checks.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { findServicesUsingSecret, type SecretRecord, type SecretsBackend, type ServiceRecord, type ServicesRegistry } from "./secrets-backend.ts";
import {
	claimSecretsCommandName,
	listSecretsContributors,
	registerSecretsContributor,
	type SecretsContribution,
	type SecretsContributor,
} from "./secrets-registry.ts";

/** Top-level menu item values, exported so a consumer's own tests can recognize navigation through the two-menu split without hardcoding magic strings. */
export const SERVICES_MENU = "__daemon_kit_secrets_services_menu__";
export const SECRETS_MENU = "__daemon_kit_secrets_secrets_menu__";

export type PickFromList = (ctx: ExtensionCommandContext, title: string, items: SelectItem[], helpText: string) => Promise<string | null>;

async function defaultPick(ctx: ExtensionCommandContext, title: string, items: SelectItem[], helpText: string): Promise<string | null> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${title}: ${items.map((item) => item.label).join(", ") || "(none)"}`, "info");
		return null;
	}
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", helpText), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ── Pure descriptions (state -> string, no I/O, no pick) ───────────────────

export function describeExpiry(expiresAt: string | undefined): string {
	if (!expiresAt) return "no expiry";
	const target = new Date(expiresAt).getTime();
	if (Number.isNaN(target)) return "no expiry";
	const remainingMs = target - Date.now();
	if (remainingMs <= 0) return "expired";
	const hours = Math.round(remainingMs / (60 * 60 * 1000));
	if (hours < 1) return "expires in <1h";
	if (hours < 48) return `expires in ${hours}h`;
	return `expires in ${Math.round(hours / 24)}d`;
}

export function describeSecret(record: SecretRecord | undefined): string {
	if (!record?.configured) return "not configured";
	const parts: string[] = [describeExpiry(record.expiresAt)];
	if (record.scope) parts.push(`scope: ${record.scope}`);
	return parts.join(" \u2022 ");
}

export function describeService(service: ServiceRecord, allSecretNames: Set<string>): string {
	const missing = service.backends.filter((b) => !allSecretNames.has(b));
	const uidPart = service.uid !== undefined ? `uid ${service.uid}` : undefined;
	const parts = [`${service.backends.length} backend${service.backends.length === 1 ? "" : "s"}`];
	if (missing.length > 0) parts.push(`${missing.length} unconfigured`);
	if (uidPart) parts.push(uidPart);
	return parts.join(" \u2022 ");
}

// ── Pure menu-value encoding (a same-named record from two backends must not collide) ──

const VALUE_SEPARATOR = "\u0000";

export function encodeSecretMenuValue(source: string, name: string): string {
	return `${source}${VALUE_SEPARATOR}${name}`;
}

export function decodeSecretMenuValue(value: string): { source: string; name: string } | undefined {
	const [source, name] = value.split(VALUE_SEPARATOR);
	return source && name ? { source, name } : undefined;
}

// ── Pure item builders (state -> SelectItem[], no I/O, no pick) ────────────

export type SecretEntry = { backend: SecretsBackend; record: SecretRecord };

/** An action appended to the [secrets] menu that isn't a SecretRecord at all -- e.g. Enigma's own "+ Log in a backend", whose OAuth-device-flow/static-token registration is too vendor-specific for the generic SecretsBackend port to model. */
export interface SecretsMenuAction {
	value: string;
	label: string;
	description?: string;
	run: (ctx: ExtensionCommandContext) => Promise<void>;
}

export function buildSecretsMenuItems(entries: SecretEntry[], extraActions: SecretsMenuAction[]): SelectItem[] {
	return [
		...entries.map(({ backend, record }) => ({
			value: encodeSecretMenuValue(backend.source, record.name),
			label: `${record.name} (${backend.source})`,
			description: describeSecret(record),
		})),
		...extraActions.map((action) => ({ value: action.value, label: action.label, description: action.description })),
	];
}

export function buildServicesMenuItems(services: ServiceRecord[], allSecretNames: Set<string>): SelectItem[] {
	return services.map((service) => ({ value: service.name, label: service.name, description: describeService(service, allSecretNames) }));
}

export function buildServiceDetailItems(service: ServiceRecord, secretsByName: Map<string, SecretRecord>): SelectItem[] {
	return [
		...service.backends.map((name) => {
			const record = secretsByName.get(name);
			return { value: name, label: name, description: record ? describeSecret(record) : "not configured anywhere" };
		}),
		{ value: "back", label: "Back" },
	];
}

export const SECRET_ACTION_ITEMS: SelectItem[] = [
	{ value: "rotate", label: "Rotate", description: "Refresh this credential in place" },
	{ value: "revoke", label: "Revoke", description: "Delete the stored credential" },
	{ value: "back", label: "Back" },
];

// ── Backend aggregation ─────────────────────────────────────────────────────

export class SecretsBackendListError extends Error {
	constructor(
		public readonly source: string,
		public readonly causeMessage: string,
	) {
		super(`${source}: ${causeMessage}`);
		this.name = "SecretsBackendListError";
	}
}

/**
 * Every backend's records. A remote backend's list() can fail mid-session
 * (the vault daemon restarting, a network blip) -- this always throws
 * SecretsBackendListError naming which backend failed, rather than a raw
 * error a caller has to inspect to attribute.
 */
export async function loadAllSecrets(backends: SecretsBackend[]): Promise<SecretEntry[]> {
	const all: SecretEntry[] = [];
	for (const backend of backends) {
		let records: SecretRecord[];
		try {
			records = await backend.list();
		} catch (error) {
			throw new SecretsBackendListError(backend.source, error instanceof Error ? error.message : String(error));
		}
		for (const record of records) all.push({ backend, record });
	}
	return all;
}

/** Converts a SecretsBackendListError into a notify("error") and `undefined`, instead of an uncaught throw out of the command. */
async function loadAllSecretsOrNotify(ctx: ExtensionCommandContext, backends: SecretsBackend[]): Promise<SecretEntry[] | undefined> {
	try {
		return await loadAllSecrets(backends);
	} catch (error) {
		if (error instanceof SecretsBackendListError) {
			ctx.ui.notify(`Could not reach the "${error.source}" backend: ${error.causeMessage}`, "error");
			return undefined;
		}
		throw error;
	}
}

// ── Mutating actions (I/O, but directly callable/testable without any pick()) ──

export async function performRotate(ctx: ExtensionCommandContext, backend: SecretsBackend, name: string): Promise<void> {
	try {
		await backend.rotate(name);
		ctx.ui.notify(`${name}: rotated.`, "info");
	} catch (error) {
		ctx.ui.notify(`${name}: rotate failed (${error instanceof Error ? error.message : String(error)})`, "error");
	}
}

/** Resolves true if the credential was actually revoked (confirmed and no error), false if declined or failed. */
export async function performRevoke(ctx: ExtensionCommandContext, backend: SecretsBackend, name: string): Promise<boolean> {
	const confirmed = ctx.hasUI ? await ctx.ui.confirm(`Revoke ${name}?`, "This deletes the stored credential. Re-authenticate to restore it.") : false;
	if (!confirmed) return false;
	try {
		await backend.revoke(name);
		ctx.ui.notify(`${name}: revoked.`, "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`${name}: revoke failed (${error instanceof Error ? error.message : String(error)})`, "error");
		return false;
	}
}

// ── Thin navigation loops: wire the pieces above to a real pick(); no logic of their own ──

async function manageSecret(ctx: ExtensionCommandContext, backend: SecretsBackend, name: string, pick: PickFromList): Promise<void> {
	for (;;) {
		const record = await backend.get(name);
		const action = await pick(ctx, `${name} (${backend.source}) \u2014 ${describeSecret(record)}`, SECRET_ACTION_ITEMS, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!action || action === "back") return;
		if (action === "rotate") {
			await performRotate(ctx, backend, name);
			continue;
		}
		if (action === "revoke" && (await performRevoke(ctx, backend, name))) return; // nothing left to manage once revoked
	}
}

async function secretsMenu(ctx: ExtensionCommandContext, backends: SecretsBackend[], pick: PickFromList, extraActions: SecretsMenuAction[]): Promise<void> {
	for (;;) {
		const entries = await loadAllSecretsOrNotify(ctx, backends);
		if (!entries) return;
		if (entries.length === 0 && extraActions.length === 0) {
			ctx.ui.notify("No secrets known yet across any configured backend.", "info");
			return;
		}
		const items = buildSecretsMenuItems(entries, extraActions);
		const selected = await pick(ctx, "All secrets", items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!selected) return;
		const extraAction = extraActions.find((action) => action.value === selected);
		if (extraAction) {
			await extraAction.run(ctx);
			continue;
		}
		const decoded = decodeSecretMenuValue(selected);
		if (!decoded) continue;
		const backend = backends.find((b) => b.source === decoded.source);
		if (!backend) continue;
		await manageSecret(ctx, backend, decoded.name, pick);
	}
}

async function manageService(ctx: ExtensionCommandContext, service: ServiceRecord, backends: SecretsBackend[], pick: PickFromList): Promise<void> {
	const allSecrets = await loadAllSecretsOrNotify(ctx, backends);
	if (!allSecrets) return;
	const byName = new Map(allSecrets.map(({ record }) => [record.name, record]));
	await pick(ctx, `${service.name} \u2014 secrets in use`, buildServiceDetailItems(service, byName), "\u2191\u2193 navigate \u2022 esc back");
}

async function servicesMenu(ctx: ExtensionCommandContext, registry: ServicesRegistry, backends: SecretsBackend[], pick: PickFromList): Promise<void> {
	for (;;) {
		const services = await registry.list();
		if (services.length === 0) {
			ctx.ui.notify("No services registered yet.", "info");
			return;
		}
		const entries = await loadAllSecretsOrNotify(ctx, backends);
		if (!entries) return;
		const allSecretNames = new Set(entries.map(({ record }) => record.name));
		const selected = await pick(ctx, "Services", buildServicesMenuItems(services, allSecretNames), "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!selected) return;
		const service = services.find((s) => s.name === selected);
		if (service) await manageService(ctx, service, backends, pick);
	}
}

export interface RunSecretsCommandOptions {
	backends: SecretsBackend[];
	/** Omit to skip the [services] menu entirely -- a consumer with nothing service-registry-shaped still gets a working [secrets] view. */
	servicesRegistry?: ServicesRegistry;
	/** Appended to the [secrets] menu below every real secret record. */
	extraActions?: SecretsMenuAction[];
	pick?: PickFromList;
}

export const TOP_LEVEL_MENU_ITEMS: SelectItem[] = [
	{ value: SERVICES_MENU, label: "[services]", description: "Consumers and which secrets each one uses" },
	{ value: SECRETS_MENU, label: "[secrets]", description: "Named credentials: status, rotate, revoke" },
];

export async function runSecretsCommand(ctx: ExtensionCommandContext, options: RunSecretsCommandOptions): Promise<void> {
	const pick = options.pick ?? defaultPick;
	const extraActions = options.extraActions ?? [];
	if (!options.servicesRegistry) {
		await secretsMenu(ctx, options.backends, pick, extraActions);
		return;
	}

	for (;;) {
		const selected = await pick(ctx, "Secrets", TOP_LEVEL_MENU_ITEMS, "\u2191\u2193 navigate \u2022 enter select \u2022 esc close");
		if (!selected) return;
		if (selected === SERVICES_MENU) await servicesMenu(ctx, options.servicesRegistry, options.backends, pick);
		else await secretsMenu(ctx, options.backends, pick, extraActions);
	}
}

/**
 * Registers the command on the given extension -- `/secrets` by default,
 * but Pi has no per-extension command namespacing: two extensions calling
 * this with the default name collide (whichever registers last silently
 * wins pi's own dispatch table). A consumer sharing a Pi session with
 * another daemon-kit-based /secrets registration (e.g. pi-enigma) must
 * pass a distinct commandName instead. `resolveOptions` is called fresh on
 * every invocation, so a caller can rebuild backends against the current
 * daemon state instead of capturing one snapshot at extension-load time.
 */
export function registerSecretsCommand(
	pi: ExtensionAPI,
	resolveOptions: () => RunSecretsCommandOptions | Promise<RunSecretsCommandOptions>,
	commandName = "secrets",
): void {
	pi.registerCommand(commandName, {
		description: "Manage credentials: view status, rotate, or revoke, across every configured backend",
		handler: async (_args, ctx) => runSecretsCommand(ctx, await resolveOptions()),
	});
}

/**
 * Merges every contributor's freshly-resolved SecretsContribution into one
 * RunSecretsCommandOptions -- backends and extraActions concatenate;
 * ServicesRegistry.list() results concatenate across every contributor
 * that supplied one (Enigma's real vault clients alongside tickets' own
 * self-declared entry both show up in the same [services] menu). Exported
 * directly (not just used inside registerSharedSecretsCommand) so a test
 * can assert on the merge itself without touching the process-wide
 * registry at all.
 */
export function mergeSecretsContributions(contributions: SecretsContribution[]): RunSecretsCommandOptions {
	const backends = contributions.flatMap((c) => c.backends);
	const extraActions = contributions.flatMap((c) => c.extraActions ?? []);
	const registries = contributions.map((c) => c.servicesRegistry).filter((r): r is ServicesRegistry => r !== undefined);
	const servicesRegistry: ServicesRegistry | undefined =
		registries.length === 0 ? undefined : { list: async () => (await Promise.all(registries.map((r) => r.list()))).flat() };
	return { backends, extraActions, servicesRegistry };
}

/**
 * Registers this consumer as a contributor to the shared `/secrets`
 * namespace (default commandName) instead of a standalone command of its
 * own. Every consumer calling this -- Enigma, pipes, tickets, whichever
 * order they load in -- lands in the same `/secrets` command: exactly one
 * of them (whichever gets here first) actually calls pi.registerCommand,
 * per claimSecretsCommandName's contract; every other one still shows up
 * because the command handler re-reads every registered contributor fresh
 * on each invocation, not just the claiming one's own.
 *
 * Use registerSecretsCommand instead when a consumer genuinely wants its
 * own standalone command, unrelated to any other daemon-kit consumer's
 * secrets (rare -- most consumers sharing a Pi session want the same
 * `/secrets` surface).
 */
export function registerSharedSecretsCommand(pi: ExtensionAPI, contributor: SecretsContributor, commandName = "secrets"): void {
	registerSecretsContributor(contributor);
	if (!claimSecretsCommandName(commandName)) return; // another consumer already owns the actual command registration -- my contribution above still merges in
	pi.registerCommand(commandName, {
		description: "Manage credentials: view status, rotate, or revoke, across every configured backend",
		handler: async (_args, ctx) => {
			const resolved = await Promise.all(listSecretsContributors().map((c) => c.resolve()));
			await runSecretsCommand(ctx, mergeSecretsContributions(resolved));
		},
	});
}

export { findServicesUsingSecret };
export type { SecretRecord, SecretsBackend, ServiceRecord, ServicesRegistry };
export type { SecretsContribution, SecretsContributor } from "./secrets-registry.ts";
export { registerSecretsContributor, unregisterSecretsContributor, listSecretsContributors, claimSecretsCommandName } from "./secrets-registry.ts";
