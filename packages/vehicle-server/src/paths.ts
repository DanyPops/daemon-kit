/**
 * XDG-compliant (Linux)/native-convention (macOS, Windows) process/storage
 * layout and authenticated discovery. Generalizes what was byte-identical
 * between web-spider-daemon and jittor's state.ts (down to the same header
 * comment admitting the duplication), and supersedes papyrus's/pi-packed's
 * older, non-atomic, non-XDG-split variants of the same problem.
 *
 * Per-OS directory conventions are cross-checked directly against
 * `env-paths` (a devDependency used only in this module's own tests, never
 * imported at runtime -- this file stays dependency-free so it keeps
 * loading safely under Pi's jiti loader, see pi-load-harness.ts). macOS and
 * Windows have no equivalent of XDG_RUNTIME_DIR (a session-scoped, 0700,
 * auto-cleared-on-logout directory) -- the handle file lives under each
 * platform's own temp directory there instead, which is fine for a handle
 * already treated as untrusted and validated by shape on read, but does not
 * carry those stronger guarantees outside Linux.
 *
 * Every @danypops daemon binds loopback-only; that is a hard security
 * invariant of this kit, not a per-daemon configuration choice, so
 * LOOPBACK_HOST is fixed here rather than accepted as a parameter.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";

export interface DaemonPaths {
	/** Linux: XDG_DATA_HOME/<name>/<databaseFilename>. macOS: ~/Library/Application Support/<name>/<databaseFilename>. Windows: %LOCALAPPDATA%\<name>\Data\<databaseFilename>. */
	database: string;
	/** Linux: XDG_STATE_HOME/<name>/<tokenFilename>. macOS/Windows: alongside `database` -- neither platform has a distinct "state" convention separate from app data. */
	token: string;
	/** Linux: XDG_RUNTIME_DIR/<name>/<handleFilename>. macOS/Windows: under the OS temp directory -- see the module doc comment for why this is a weaker guarantee than XDG_RUNTIME_DIR there. */
	handle: string;
	/**
	 * Platform-neutral location for this daemon's optional persistence
	 * descriptor: a systemd --user unit on Linux; a launchd plist or Windows
	 * Registry Run value elsewhere. This module only resolves a directory --
	 * generating and installing the actual per-platform descriptor is the
	 * cross-platform service-install work, not this one.
	 */
	serviceDescriptor: string;
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
	/** Defaults to process.platform. Injectable so tests can assert every platform's paths from any host OS. */
	platform?: NodeJS.Platform;
}

export interface DaemonPathNames {
	/** Directory name under each platform's root, e.g. "web-spider" or "jittor". */
	stateDirectoryName: string;
	databaseFilename: string;
	tokenFilename: string;
	handleFilename: string;
	/** Input filename for the Linux systemd unit specifically (e.g. "acme.service") -- other platforms' service-install work supplies their own naming. */
	systemdUnitName: string;
}

export function resolveDaemonPaths(names: DaemonPathNames, options: PathEnvironment = {}): DaemonPaths {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	if (platform === "darwin") return resolveMacDaemonPaths(names, home);
	if (platform === "win32") return resolveWindowsDaemonPaths(names, options.env ?? process.env, home);
	return resolveLinuxDaemonPaths(names, options, home);
}

function resolveLinuxDaemonPaths(names: DaemonPathNames, options: PathEnvironment, home: string): DaemonPaths {
	const env = options.env ?? process.env;
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const dataHome = env.XDG_DATA_HOME ?? join(home, ".local", "share");
	const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
	const runtimeHome = env.XDG_RUNTIME_DIR ?? join("/run", "user", String(uid));
	const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
	return {
		database: join(dataHome, names.stateDirectoryName, names.databaseFilename),
		token: join(stateHome, names.stateDirectoryName, names.tokenFilename),
		handle: join(runtimeHome, names.stateDirectoryName, names.handleFilename),
		serviceDescriptor: join(configHome, "systemd", "user", names.systemdUnitName),
	};
}

function resolveMacDaemonPaths(names: DaemonPathNames, home: string): DaemonPaths {
	const library = join(home, "Library");
	const appSupport = join(library, "Application Support", names.stateDirectoryName);
	return {
		database: join(appSupport, names.databaseFilename),
		token: join(appSupport, names.tokenFilename),
		handle: join(tmpdir(), names.stateDirectoryName, names.handleFilename),
		serviceDescriptor: join(appSupport, names.systemdUnitName),
	};
}

function resolveWindowsDaemonPaths(names: DaemonPathNames, env: Record<string, string | undefined>, home: string): DaemonPaths {
	// path.win32 (not the bare, host-dependent `join`) so this produces real
	// backslash-separated Windows paths even when resolved on a Linux/macOS
	// dev or CI host -- the only way this is testable off real Windows.
	const localAppData = env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
	const appData = env.APPDATA ?? win32.join(home, "AppData", "Roaming");
	const dataDir = win32.join(localAppData, names.stateDirectoryName, "Data");
	return {
		database: win32.join(dataDir, names.databaseFilename),
		token: win32.join(dataDir, names.tokenFilename),
		handle: win32.join(localAppData, "Temp", names.stateDirectoryName, names.handleFilename),
		serviceDescriptor: win32.join(appData, names.stateDirectoryName, "Config", names.systemdUnitName),
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

/**
 * Atomic write-then-rename so a reader never observes a partial handle file.
 * mode defaults to 0600 (owner-only) -- correct for the common case of a
 * same-user daemon and consumer. A daemon meant to be discovered across OS
 * users (e.g. a system service like a shared credential vault) can pass
 * 0644: the handle's own content (host/port/pid) is never sensitive, unlike
 * the daemon's own auth token, which stays owner-only regardless.
 */
export function writeDaemonHandle(handlePath: string, handle: DaemonHandle, mode = 0o600): void {
	// A world-readable handle needs a traversable directory too, or the file mode alone
	// is moot -- only matters when this call itself creates the directory; a systemd
	// RuntimeDirectory=/RuntimeDirectoryMode= unit directive typically creates it first.
	const dirMode = mode & 0o044 ? 0o755 : 0o700;
	mkdirSync(dirname(handlePath), { recursive: true, mode: dirMode });
	const temporary = `${handlePath}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(handle)}\n`, { mode });
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

export type AcquireLockResult = { acquired: true } | { acquired: false; holderPid: number | null };

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but we lack permission to signal it -- still alive.
		// Any other error (ESRCH, or an invalid pid) means it is not.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function tryCreateLock(lockPath: string): boolean {
	try {
		// O_CREAT|O_EXCL ('wx'): a single atomic syscall that fails with EEXIST
		// if the file already exists -- no check-then-act window, the same
		// atomicity class as writeDaemonHandle's write-then-rename.
		writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function readLockPid(lockPath: string): number | null {
	try {
		const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
		return Number.isInteger(pid) ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Atomically claims the single-instance lock so at most one daemon process
 * ever proceeds to bind a port, regardless of how many callers race to
 * start one concurrently (N Pi sessions all auto-spawning at once, or a
 * human running `serve` twice by hand). A losing caller must not bind a
 * port or touch the handle file at all -- it should exit(0) as a normal
 * join, never as an error.
 *
 * A lock naming a pid that is no longer alive (crash, -9, OOM-kill left it
 * behind without running the matching releaseDaemonLock) is detected via a
 * liveness check and atomically stolen rather than blocking forever --
 * self-healing without any manual cleanup.
 */
export function acquireDaemonLock(lockPath: string, isPidAlive: (pid: number) => boolean = defaultIsPidAlive): AcquireLockResult {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	if (tryCreateLock(lockPath)) return { acquired: true };

	const existing = readLockPid(lockPath);
	if (existing !== null && isPidAlive(existing)) return { acquired: false, holderPid: existing };

	// Stale (dead pid) or unreadable/corrupt lock -- steal it. A concurrent
	// stealer could win the race between this rm and the next create; either
	// way exactly one of them ends up holding the lock afterward, since the
	// create itself is still atomic.
	rmSync(lockPath, { force: true });
	if (tryCreateLock(lockPath)) return { acquired: true };
	return { acquired: false, holderPid: readLockPid(lockPath) };
}

/** Releases the single-instance lock. Idempotent -- safe to call even if this process never held it. */
export function releaseDaemonLock(lockPath: string): void {
	rmSync(lockPath, { force: true });
}
