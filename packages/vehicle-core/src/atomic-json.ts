/**
 * Cross-platform atomic JSON persistence -- shared by every Vehicle
 * primitive that needs durable state (Jobs' status file, Watchers'
 * registry) so a crash or concurrent read never observes a half-written
 * file. Lives in vehicle-core (not vehicle-server) but stays fs-free
 * itself: every filesystem operation is injected via `AtomicJsonFsAdapter`,
 * matching vehicle-core's own "zero runtime dependencies" invariant --
 * the caller (vehicle-server, vehicle-client-pi) supplies real node:fs
 * functions, this module only sequences them.
 *
 * Modeled on github.com/nicobailon/pi-subagents' `createAtomicJsonWriter`:
 * a collision-safe temp filename, injectable fs/now/pid/random for
 * deterministic tests, and explicit Windows-aware rename retry (a plain
 * `fs.rename` onto an existing path can transiently fail on Windows if
 * another process -- antivirus, search indexing -- has the destination
 * briefly open; POSIX rename() has no such failure mode, so retrying by
 * default there would only add latency for a class of error that never
 * happens).
 */

export interface AtomicJsonFsAdapter {
	/** `mode` is a POSIX file-mode bitmask (e.g. 0o600); omitted means the platform/adapter's own default. */
	writeFile(path: string, data: string, mode?: number): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	readFile(path: string): Promise<string>;
}

export interface AtomicJsonWriteOptions {
	/** POSIX file-mode bitmask for the written file (e.g. 0o600 for a secret/credential-adjacent file). Omitted means the adapter's own default. */
	readonly mode?: number;
	/** Pretty-prints with 2-space indentation (matching JSON.stringify(value, null, 2)) for a human-editable file. Defaults to false (compact). */
	readonly pretty?: boolean;
	/** Appends a trailing "\n" -- the common POSIX text-file convention. Defaults to false (exact JSON.stringify output, unchanged). */
	readonly trailingNewline?: boolean;
}

export interface AtomicJsonWriterOptions {
	readonly fs: AtomicJsonFsAdapter;
	/** Defaults to Date.now. */
	readonly now?: () => number;
	/** Defaults to the current process's pid, or 0 outside Node/Bun. */
	readonly pid?: () => number;
	/** Defaults to a short random hex string. */
	readonly random?: () => string;
	/**
	 * Whether a failed rename onto the destination is retried at all.
	 * Defaults to `process.platform === "win32"` -- off on Linux/macOS,
	 * where a transient rename failure isn't a real failure mode.
	 */
	readonly retryRename?: boolean;
	/** Error codes on `rename` worth retrying. Defaults to ["EPERM", "EBUSY", "EACCES"] (the documented Windows file-lock codes). */
	readonly retryRenameErrors?: readonly string[];
	/** Delay before each retry attempt, in order. Defaults to [50, 100, 200]. */
	readonly retryDelaysMs?: readonly number[];
	/** Injectable so a test doesn't have to sleep for real. Defaults to setTimeout. */
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface AtomicJsonWriter {
	/** Serializes `value` to JSON and writes it to `filePath` atomically (temp file + rename). */
	write(filePath: string, value: unknown, options?: AtomicJsonWriteOptions): Promise<void>;
	/** Reads and JSON.parses `filePath`. Returns undefined if the file doesn't exist (fs.readFile throws ENOENT); rethrows any other error. */
	read(filePath: string): Promise<unknown | undefined>;
}

function defaultPlatformIsWindows(): boolean {
	return typeof process !== "undefined" && process.platform === "win32";
}

function defaultPid(): number {
	return typeof process !== "undefined" ? process.pid : 0;
}

function defaultRandom(): string {
	return Math.random().toString(36).slice(2, 10);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function dirAndBase(filePath: string): { readonly dir: string; readonly base: string } {
	const separator = filePath.lastIndexOf("/");
	if (separator === -1) return { dir: ".", base: filePath };
	return { dir: filePath.slice(0, separator) || "/", base: filePath.slice(separator + 1) };
}

export function createAtomicJsonWriter(options: AtomicJsonWriterOptions): AtomicJsonWriter {
	const fsAdapter = options.fs;
	const now = options.now ?? Date.now;
	const pid = options.pid ?? defaultPid;
	const random = options.random ?? defaultRandom;
	const retryRename = options.retryRename ?? defaultPlatformIsWindows();
	const retryRenameErrors = options.retryRenameErrors ?? ["EPERM", "EBUSY", "EACCES"];
	const retryDelaysMs = options.retryDelaysMs ?? [50, 100, 200];
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	async function renameWithRetry(tempPath: string, filePath: string): Promise<void> {
		let attempt = 0;
		for (;;) {
			try {
				await fsAdapter.rename(tempPath, filePath);
				return;
			} catch (error) {
				const retryable = retryRename && isErrnoException(error) && !!error.code && retryRenameErrors.includes(error.code);
				if (!retryable || attempt >= retryDelaysMs.length) throw error;
				await sleep(retryDelaysMs[attempt] ?? 0);
				attempt++;
			}
		}
	}

	return {
		async write(filePath, value, options) {
			let serialized: string | undefined;
			try {
				serialized = options?.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
			} catch (error) {
				throw new Error(`atomic-json: value for ${filePath} is not JSON-serializable`, { cause: error });
			}
			if (serialized === undefined) throw new Error(`atomic-json: value for ${filePath} is not JSON-serializable`);
			if (options?.trailingNewline) serialized += "\n";
			const { dir, base } = dirAndBase(filePath);
			const tempPath = `${dir}/.${base}.${pid()}.${now()}.${random()}.tmp`;
			await fsAdapter.writeFile(tempPath, serialized, options?.mode);
			try {
				await renameWithRetry(tempPath, filePath);
			} catch (error) {
				try {
					await fsAdapter.unlink(tempPath);
				} catch {
					// Best-effort cleanup -- the rename failure itself is the real error to surface.
				}
				throw error;
			}
		},
		async read(filePath) {
			try {
				const raw = await fsAdapter.readFile(filePath);
				return JSON.parse(raw) as unknown;
			} catch (error) {
				if (isErrnoException(error) && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
	};
}
