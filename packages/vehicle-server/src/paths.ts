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

/**
 * Independently declared from daemon.ts's own LaunchProvenance (same three literals) rather
 * than imported -- this file stays dependency-free by design (see the module doc comment),
 * and the two unions are structurally identical so a LaunchProvenance value already passes
 * through unchanged wherever this type is expected.
 */
export type LockLaunchProvenance = "auto-spawn" | "service" | "unknown";

export type AcquireLockResult =
	| { acquired: true }
	| { acquired: false; holderPid: number | null; holderProvenance: LockLaunchProvenance | null };

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

function defaultKill(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone -- nothing left to signal, not a failure of the reclaim itself.
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryCreateLock(lockPath: string, provenance: LockLaunchProvenance): boolean {
	try {
		// O_CREAT|O_EXCL ('wx'): a single atomic syscall that fails with EEXIST
		// if the file already exists -- no check-then-act window, the same
		// atomicity class as writeDaemonHandle's write-then-rename. Provenance on
		// its own line, not parsed by anything that predates it -- a lock file
		// written before this field existed just reads back with provenance null.
		writeFileSync(lockPath, `${process.pid}\n${provenance}\n`, { mode: 0o600, flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function readLockInfo(lockPath: string): { pid: number; provenance: LockLaunchProvenance | null } | null {
	try {
		const lines = readFileSync(lockPath, "utf8").split("\n");
		const pid = Number.parseInt((lines[0] ?? "").trim(), 10);
		if (!Number.isInteger(pid)) return null;
		const rawProvenance = (lines[1] ?? "").trim();
		const provenance =
			rawProvenance === "auto-spawn" || rawProvenance === "service" || rawProvenance === "unknown" ? rawProvenance : null;
		return { pid, provenance };
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
 *
 * `provenance` records who is asking (matching daemon.ts's own launch-provenance
 * signal) so a later failed acquisition can tell an unmanaged holder apart from a
 * supervised one -- see acquireDaemonLockAsService, the only current reader of
 * holderProvenance.
 */
export function acquireDaemonLock(
	lockPath: string,
	isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
	provenance: LockLaunchProvenance = "unknown",
): AcquireLockResult {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	if (tryCreateLock(lockPath, provenance)) return { acquired: true };

	const existing = readLockInfo(lockPath);
	if (existing !== null && isPidAlive(existing.pid)) {
		return { acquired: false, holderPid: existing.pid, holderProvenance: existing.provenance };
	}

	// Stale (dead pid) or unreadable/corrupt lock -- steal it. A concurrent
	// stealer could win the race between this rm and the next create; either
	// way exactly one of them ends up holding the lock afterward, since the
	// create itself is still atomic.
	rmSync(lockPath, { force: true });
	if (tryCreateLock(lockPath, provenance)) return { acquired: true };
	const stolen = readLockInfo(lockPath);
	return { acquired: false, holderPid: stolen?.pid ?? null, holderProvenance: stolen?.provenance ?? null };
}

/** Releases the single-instance lock. Idempotent -- safe to call even if this process never held it. */
export function releaseDaemonLock(lockPath: string): void {
	rmSync(lockPath, { force: true });
}

export interface ReclaimLogEvent {
	readonly outcome: "reaped" | "skipped";
	readonly holderPid: number | null;
	readonly holderProvenance: LockLaunchProvenance | null;
	readonly method?: "sigterm" | "sigkill";
	readonly reason?: string;
}

export interface ReclaimDeps {
	isPidAlive?: (pid: number) => boolean;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	/** Called between liveness polls while waiting out the grace period. Defaults to a real setTimeout-backed delay; tests inject a no-delay version so the grace period costs no real wall-clock time. */
	sleep?: (ms: number) => Promise<void>;
	/** Total time budget for each of the SIGTERM and (if needed) SIGKILL waits. Defaults to 5s -- this is a loopback RPC server with no long-running work to flush, closer to nginx's fast-shutdown posture than a stateful job's. */
	graceMs?: number;
	pollIntervalMs?: number;
	/** One record per decision, not just per kill -- a skipped reap needs to be exactly as visible as an executed one. */
	log?: (event: ReclaimLogEvent) => void;
}

const DEFAULT_RECLAIM_GRACE_MS = 5_000;
const DEFAULT_RECLAIM_POLL_INTERVAL_MS = 100;

async function waitUntilDead(
	pid: number,
	isPidAlive: (pid: number) => boolean,
	sleep: (ms: number) => Promise<void>,
	graceMs: number,
	pollIntervalMs: number,
): Promise<boolean> {
	const attempts = Math.max(1, Math.ceil(graceMs / pollIntervalMs));
	for (let attempt = 0; attempt < attempts && isPidAlive(pid); attempt++) {
		await sleep(pollIntervalMs);
	}
	return !isPidAlive(pid);
}

/**
 * acquireDaemonLock, plus one extra right reserved to a "service"-provenance caller (an
 * Armada/systemd-supervised (re)start): reclaiming the lock from an unmanaged holder that
 * has no standing to block it. A holder that is itself "service"-provenance is left alone
 * exactly like a plain acquireDaemonLock failure -- that is a genuine simultaneous-restart
 * race between two supervised launches, not an orphan to reap. A holder with no recorded
 * provenance at all (a lock file written before this field existed) is treated the same as
 * "unknown" -- reapable -- matching readLaunchProvenance's own fallback rule elsewhere in
 * this kit (an unrecognized launch is closer to auto-spawn than to a trusted service).
 *
 * Never reaped blind: the holder's liveness is re-checked immediately before signaling it
 * (closing the gap between acquireDaemonLock's own check and this call), and the lock is
 * force-cleared only once the holder is confirmed dead -- never while it might still be a
 * live, legitimately-running process. This mirrors Armada's own fleet cleanup (fleet/cleanup.ts),
 * which re-derives its kill plan from live state immediately before executing it rather than
 * trusting an earlier snapshot.
 */
export async function acquireDaemonLockAsService(lockPath: string, deps: ReclaimDeps = {}): Promise<AcquireLockResult> {
	const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
	const kill = deps.kill ?? defaultKill;
	const sleep = deps.sleep ?? defaultSleep;
	const graceMs = deps.graceMs ?? DEFAULT_RECLAIM_GRACE_MS;
	const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_RECLAIM_POLL_INTERVAL_MS;

	const first = acquireDaemonLock(lockPath, isPidAlive, "service");
	if (first.acquired) return first;

	if (first.holderProvenance === "service" || first.holderPid === null) {
		deps.log?.({
			outcome: "skipped",
			holderPid: first.holderPid,
			holderProvenance: first.holderProvenance,
			reason: first.holderProvenance === "service" ? "holder is itself a supervised instance" : "no live holder pid to reap",
		});
		return first;
	}

	const holderPid = first.holderPid;
	if (!isPidAlive(holderPid)) {
		// Died between the read above and here -- acquireDaemonLock already steals a dead
		// holder's lock on its own, so just retry rather than signaling a pid that is gone.
		return acquireDaemonLock(lockPath, isPidAlive, "service");
	}

	kill(holderPid, "SIGTERM");
	let exited = await waitUntilDead(holderPid, isPidAlive, sleep, graceMs, pollIntervalMs);
	let method: "sigterm" | "sigkill" = "sigterm";
	if (!exited) {
		method = "sigkill";
		kill(holderPid, "SIGKILL");
		exited = await waitUntilDead(holderPid, isPidAlive, sleep, graceMs, pollIntervalMs);
	}
	if (!exited) {
		deps.log?.({
			outcome: "skipped",
			holderPid,
			holderProvenance: first.holderProvenance,
			reason: "holder did not exit even after SIGKILL",
		});
		return { acquired: false, holderPid, holderProvenance: first.holderProvenance };
	}

	// The reaped process's own shutdown path (which would call releaseDaemonLock itself) can't
	// be trusted to have run -- SIGKILL never gives it the chance, and even a clean SIGTERM exit
	// races this function's own next acquire attempt -- so force-clear unconditionally now that
	// the holder is confirmed dead.
	releaseDaemonLock(lockPath);
	deps.log?.({ outcome: "reaped", holderPid, holderProvenance: first.holderProvenance, method });
	return acquireDaemonLock(lockPath, isPidAlive, "service");
}
