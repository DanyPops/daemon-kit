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
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { findServicesUsingSecret, type SecretRecord, type SecretsBackend, type ServiceRecord, type ServicesRegistry } from "./secrets-backend.ts";

const SERVICES_MENU = "__daemon_kit_secrets_services_menu__";
const SECRETS_MENU = "__daemon_kit_secrets_secrets_menu__";
const BACK = "__daemon_kit_secrets_back__";

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

function describeSecret(record: SecretRecord): string {
	if (!record.configured) return "not configured";
	const parts: string[] = [describeExpiry(record.expiresAt)];
	if (record.scope) parts.push(`scope: ${record.scope}`);
	return parts.join(" \u2022 ");
}

function describeExpiry(expiresAt: string | undefined): string {
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

/** Every backend's records, source-qualified so two backends can each hold a same-named record without colliding in the merged view. */
async function loadAllSecrets(backends: SecretsBackend[]): Promise<{ backend: SecretsBackend; record: SecretRecord }[]> {
	const all: { backend: SecretsBackend; record: SecretRecord }[] = [];
	for (const backend of backends) {
		for (const record of await backend.list()) all.push({ backend, record });
	}
	return all;
}

async function manageSecret(ctx: ExtensionCommandContext, backend: SecretsBackend, name: string, pick: PickFromList): Promise<void> {
	for (;;) {
		const record = await backend.get(name);
		const status = record ? describeSecret(record) : "not configured";
		const items: SelectItem[] = [
			{ value: "rotate", label: "Rotate", description: "Refresh this credential in place" },
			{ value: "revoke", label: "Revoke", description: "Delete the stored credential" },
			{ value: "back", label: "Back" },
		];
		const action = await pick(ctx, `${name} (${backend.source}) \u2014 ${status}`, items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!action || action === "back") return;

		if (action === "rotate") {
			try {
				await backend.rotate(name);
				ctx.ui.notify(`${name}: rotated.`, "info");
			} catch (error) {
				ctx.ui.notify(`${name}: rotate failed (${error instanceof Error ? error.message : String(error)})`, "error");
			}
			continue;
		}

		if (action === "revoke") {
			const confirmed = ctx.hasUI ? await ctx.ui.confirm(`Revoke ${name}?`, "This deletes the stored credential. Re-authenticate to restore it.") : false;
			if (!confirmed) continue;
			try {
				await backend.revoke(name);
				ctx.ui.notify(`${name}: revoked.`, "info");
			} catch (error) {
				ctx.ui.notify(`${name}: revoke failed (${error instanceof Error ? error.message : String(error)})`, "error");
			}
			return;
		}
	}
}

async function secretsMenu(ctx: ExtensionCommandContext, backends: SecretsBackend[], pick: PickFromList, extraActions: SecretsMenuAction[]): Promise<void> {
	for (;;) {
		const entries = await loadAllSecrets(backends);
		if (entries.length === 0 && extraActions.length === 0) {
			ctx.ui.notify("No secrets known yet across any configured backend.", "info");
			return;
		}
		const items: SelectItem[] = [
			...entries.map(({ backend, record }) => ({
				value: `${backend.source}\u0000${record.name}`,
				label: `${record.name} (${backend.source})`,
				description: describeSecret(record),
			})),
			...extraActions.map((action) => ({ value: action.value, label: action.label, description: action.description })),
		];
		const selected = await pick(ctx, "All secrets", items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!selected) return;
		const extraAction = extraActions.find((action) => action.value === selected);
		if (extraAction) {
			await extraAction.run(ctx);
			continue;
		}
		const [source, name] = selected.split("\u0000");
		if (!source || !name) continue;
		const backend = backends.find((b) => b.source === source);
		if (!backend) continue;
		await manageSecret(ctx, backend, name, pick);
	}
}

function describeService(service: ServiceRecord, allSecretNames: Set<string>): string {
	const missing = service.backends.filter((b) => !allSecretNames.has(b));
	const uidPart = service.uid !== undefined ? `uid ${service.uid}` : undefined;
	const parts = [`${service.backends.length} backend${service.backends.length === 1 ? "" : "s"}`];
	if (missing.length > 0) parts.push(`${missing.length} unconfigured`);
	if (uidPart) parts.push(uidPart);
	return parts.join(" \u2022 ");
}

async function manageService(ctx: ExtensionCommandContext, service: ServiceRecord, backends: SecretsBackend[], pick: PickFromList): Promise<void> {
	const allSecrets = await loadAllSecrets(backends);
	const byName = new Map(allSecrets.map(({ record }) => [record.name, record]));
	const items: SelectItem[] = service.backends.map((name) => {
		const record = byName.get(name);
		return { value: name, label: name, description: record ? describeSecret(record) : "not configured anywhere" };
	});
	items.push({ value: "back", label: "Back" });
	await pick(ctx, `${service.name} \u2014 secrets in use`, items, "\u2191\u2193 navigate \u2022 esc back");
}

async function servicesMenu(ctx: ExtensionCommandContext, registry: ServicesRegistry, backends: SecretsBackend[], pick: PickFromList): Promise<void> {
	for (;;) {
		const services = await registry.list();
		if (services.length === 0) {
			ctx.ui.notify("No services registered yet.", "info");
			return;
		}
		const allSecretNames = new Set((await loadAllSecrets(backends)).map(({ record }) => record.name));
		const items: SelectItem[] = services.map((service) => ({ value: service.name, label: service.name, description: describeService(service, allSecretNames) }));
		const selected = await pick(ctx, "Services", items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!selected) return;
		const service = services.find((s) => s.name === selected);
		if (service) await manageService(ctx, service, backends, pick);
	}
}

/** An action appended to the [secrets] menu that isn't a SecretRecord at all -- e.g. Enigma's own "+ Log in a backend", whose OAuth-device-flow/static-token registration is too vendor-specific for the generic SecretsBackend port to model. */
export interface SecretsMenuAction {
	value: string;
	label: string;
	description?: string;
	run: (ctx: ExtensionCommandContext) => Promise<void>;
}

export interface RunSecretsCommandOptions {
	backends: SecretsBackend[];
	/** Omit to skip the [services] menu entirely -- a consumer with nothing service-registry-shaped still gets a working [secrets] view. */
	servicesRegistry?: ServicesRegistry;
	/** Appended to the [secrets] menu below every real secret record. */
	extraActions?: SecretsMenuAction[];
	pick?: PickFromList;
}

export async function runSecretsCommand(ctx: ExtensionCommandContext, options: RunSecretsCommandOptions): Promise<void> {
	const pick = options.pick ?? defaultPick;
	const extraActions = options.extraActions ?? [];
	if (!options.servicesRegistry) {
		await secretsMenu(ctx, options.backends, pick, extraActions);
		return;
	}

	for (;;) {
		const items: SelectItem[] = [
			{ value: SERVICES_MENU, label: "[services]", description: "Consumers and which secrets each one uses" },
			{ value: SECRETS_MENU, label: "[secrets]", description: "Named credentials: status, rotate, revoke" },
		];
		const selected = await pick(ctx, "Secrets", items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc close");
		if (!selected) return;
		if (selected === SERVICES_MENU) await servicesMenu(ctx, options.servicesRegistry, options.backends, pick);
		else await secretsMenu(ctx, options.backends, pick, extraActions);
	}
}

/** Registers `/secrets` on the given extension. `resolveOptions` is called fresh on every invocation, so a caller can rebuild backends against the current daemon state instead of capturing one snapshot at extension-load time. */
export function registerSecretsCommand(pi: ExtensionAPI, resolveOptions: () => RunSecretsCommandOptions | Promise<RunSecretsCommandOptions>): void {
	pi.registerCommand("secrets", {
		description: "Manage credentials: view status, rotate, or revoke, across every configured backend",
		handler: async (_args, ctx) => runSecretsCommand(ctx, await resolveOptions()),
	});
}

export { findServicesUsingSecret };
export type { SecretRecord, SecretsBackend, ServiceRecord, ServicesRegistry };
