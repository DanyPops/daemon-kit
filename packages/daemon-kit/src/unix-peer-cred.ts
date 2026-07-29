/**
 * Retrieves a Unix domain socket's real peer credentials (pid/uid/gid) via
 * SO_PEERCRED -- kernel-verified identity of the connecting process, not
 * something the peer can assert or forge. Bun/Node expose no high-level API
 * for this; it requires an FFI call to libc's getsockopt(2) directly.
 *
 * Linux only for now. macOS has an analogous LOCAL_PEERCRED sockopt with a
 * different struct layout, and Windows has no equivalent for AF_UNIX --
 * both are out of scope here and getPeerCredential() throws UnsupportedPlatformError
 * rather than silently returning wrong data.
 */
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

export interface PeerCredential {
	pid: number;
	uid: number;
	gid: number;
}

export class UnsupportedPlatformError extends Error {
	constructor(platform: string) {
		super(`SO_PEERCRED is only supported on Linux; running on "${platform}"`);
		this.name = "UnsupportedPlatformError";
	}
}

export class PeerCredentialLookupError extends Error {
	constructor(rc: number) {
		super(`getsockopt(SO_PEERCRED) failed with return code ${rc}`);
		this.name = "PeerCredentialLookupError";
	}
}

// struct ucred { pid_t pid; uid_t uid; gid_t gid; } -- all int32 on Linux, every arch glibc supports.
const UCRED_SIZE = 12;
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

// A dedicated function whose own return type TypeScript infers concretely from this
// one dlopen() call -- `ReturnType<typeof dlopen>` on the generic import itself would
// erase the specific Fns shape and collapse every symbol's call signature to `never`.
function openLibc() {
	// glibc's actual runtime soname is "libc.so.6", not the generic "libc.so" (a
	// dev-package-only symlink) `suffix` alone would produce on Linux.
	return dlopen(process.platform === "darwin" ? `libc.${suffix}` : "libc.so.6", {
		getsockopt: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr] as const,
			returns: FFIType.i32,
		},
	});
}

let libc: ReturnType<typeof openLibc> | undefined;

function loadLibc(): ReturnType<typeof openLibc> {
	if (!libc) libc = openLibc();
	return libc;
}

/**
 * `fd` is a raw Unix domain socket file descriptor, e.g. Bun's own
 * `socket.fd` on a connection accepted via `Bun.listen({ unix: path, ... })`
 * -- undocumented but the only accessor Bun currently exposes; guarded with
 * a runtime check here rather than trusted blindly at every call site.
 */
export function getPeerCredential(fd: number): PeerCredential {
	if (process.platform !== "linux") throw new UnsupportedPlatformError(process.platform);
	if (!Number.isInteger(fd) || fd < 0) throw new TypeError(`getPeerCredential: fd must be a non-negative integer, got ${fd}`);

	const buf = new Uint8Array(UCRED_SIZE);
	const lenBuf = new Int32Array([UCRED_SIZE]);
	const rc = loadLibc().symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(buf), ptr(lenBuf));
	if (rc !== 0) throw new PeerCredentialLookupError(rc);

	const view = new DataView(buf.buffer);
	return { pid: view.getInt32(0, true), uid: view.getInt32(4, true), gid: view.getInt32(8, true) };
}

/**
 * Bun exposes a connected socket's raw fd only via an undocumented `.fd`
 * property on the object passed to `Bun.listen`'s `socket.open(socket)`
 * handler -- centralized here so every call site shares one guarded
 * accessor instead of repeating the same unchecked cast.
 */
export function rawSocketFd(socket: unknown): number | undefined {
	if (socket === null || typeof socket !== "object") return undefined;
	const fd = (socket as { fd?: unknown }).fd;
	return typeof fd === "number" ? fd : undefined;
}
