/**
 * XDG-compliant process/storage layout and authenticated discovery.
 * Generalizes what was byte-identical between web-spider-daemon and
 * jittor's state.ts (down to the same header comment admitting the
 * duplication), and supersedes papyrus's/pi-packed's older, non-atomic,
 * non-XDG-split variants of the same problem.
 *
 * Every @danypops daemon binds loopback-only; that is a hard security
 * invariant of this kit, not a per-daemon configuration choice, so
 * LOOPBACK_HOST is fixed here rather than accepted as a parameter.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";

export interface DaemonPaths {
	/** XDG_DATA_HOME/<name>/<databaseFilename> */
	database: string;
	/** XDG_STATE_HOME/<name>/<tokenFilename> */
	token: string;
	/** XDG_RUNTIME_DIR/<name>/<handleFilename> */
	handle: string;
	/** XDG_CONFIG_HOME/systemd/user/<systemdUnitName> */
	systemdUnit: string;
}

export interface DaemonHandle {
	host: typeof LOOPBACK_HOST;
	port: number;
	pid: number;
}

export interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export interface DaemonPathNames {
	/** Directory name under each XDG root, e.g. "web-spider" or "jittor". */
	stateDirectoryName: string;
	databaseFilename: string;
	tokenFilename: string;
	handleFilename: string;
	systemdUnitName: string;
}

export function resolveDaemonPaths(names: DaemonPathNames, options: PathEnvironment = {}): DaemonPaths {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const dataHome = env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
	const stateHome = env["XDG_STATE_HOME"] ?? join(home, ".local", "state");
	const runtimeHome = env["XDG_RUNTIME_DIR"] ?? join("/run", "user", String(uid));
	const configHome = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
	return {
		database: join(dataHome, names.stateDirectoryName, names.databaseFilename),
		token: join(stateHome, names.stateDirectoryName, names.tokenFilename),
		handle: join(runtimeHome, names.stateDirectoryName, names.handleFilename),
		systemdUnit: join(configHome, "systemd", "user", names.systemdUnitName),
	};
}

/**
 * Loads the auth token, creating a fresh 256-bit one on first run.
 * @param errorLabel used only in the invalid-token error message, e.g. "Web Spider".
 */
export function ensureAuthToken(tokenPath: string, errorLabel: string): string {
	mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
	if (existsSync(tokenPath)) {
		chmodSync(tokenPath, 0o600);
		const token = readFileSync(tokenPath, "utf8").trim();
		if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`invalid ${errorLabel} authentication token`);
		return token;
	}
	const token = randomBytes(32).toString("hex");
	writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
	return token;
}

/** Atomic write-then-rename so a reader never observes a partial handle file. */
export function writeDaemonHandle(handlePath: string, handle: DaemonHandle): void {
	mkdirSync(dirname(handlePath), { recursive: true, mode: 0o700 });
	const temporary = `${handlePath}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(handle)}\n`, { mode: 0o600 });
	renameSync(temporary, handlePath);
}

export function readDaemonHandle(handlePath: string): DaemonHandle | null {
	try {
		const value = JSON.parse(readFileSync(handlePath, "utf8")) as Partial<DaemonHandle>;
		if (
			value.host !== LOOPBACK_HOST ||
			!Number.isInteger(value.port) ||
			value.port! < 1 ||
			value.port! > 65_535 ||
			!Number.isInteger(value.pid)
		) {
			return null;
		}
		return value as DaemonHandle;
	} catch {
		return null;
	}
}

export function removeDaemonHandle(handlePath: string): void {
	rmSync(handlePath, { force: true });
}
