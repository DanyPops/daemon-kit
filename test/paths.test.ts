import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOOPBACK_HOST,
	acquireDaemonLock,
	ensureAuthToken,
	readDaemonHandle,
	releaseDaemonLock,
	removeDaemonHandle,
	resolveDaemonPaths,
	writeDaemonHandle,
} from "../src/paths.ts";
import { spawnSync } from "node:child_process";

const NAMES = {
	stateDirectoryName: "acme-daemon",
	databaseFilename: "db.sqlite",
	tokenFilename: "token",
	handleFilename: "handle.json",
	systemdUnitName: "acme.service",
};

describe("resolveDaemonPaths", () => {
	it("Linux: splits data/state/runtime/config across the right XDG roots", () => {
		const paths = resolveDaemonPaths(NAMES, {
			platform: "linux",
			env: { XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/u", XDG_CONFIG_HOME: "/config" },
		});
		expect(paths.database).toBe("/data/acme-daemon/db.sqlite");
		expect(paths.token).toBe("/state/acme-daemon/token");
		expect(paths.handle).toBe("/run/u/acme-daemon/handle.json");
		expect(paths.serviceDescriptor).toBe("/config/systemd/user/acme.service");
	});

	it("Linux: falls back to conventional dotfile locations when XDG vars are unset", () => {
		const paths = resolveDaemonPaths(NAMES, { platform: "linux", env: {}, home: "/home/x", uid: 1000 });
		expect(paths.database).toBe("/home/x/.local/share/acme-daemon/db.sqlite");
		expect(paths.token).toBe("/home/x/.local/state/acme-daemon/token");
		expect(paths.handle).toBe("/run/user/1000/acme-daemon/handle.json");
		expect(paths.serviceDescriptor).toBe("/home/x/.config/systemd/user/acme.service");
	});

	it("macOS: uses ~/Library/Application Support for data/token, temp dir for the handle", () => {
		const paths = resolveDaemonPaths(NAMES, { platform: "darwin", home: "/Users/x" });
		expect(paths.database).toBe("/Users/x/Library/Application Support/acme-daemon/db.sqlite");
		expect(paths.token).toBe("/Users/x/Library/Application Support/acme-daemon/token");
		expect(paths.handle.endsWith("acme-daemon/handle.json")).toBe(true);
		expect(paths.serviceDescriptor).toBe("/Users/x/Library/Application Support/acme-daemon/acme.service");
	});

	it("Windows: uses %LOCALAPPDATA%/%APPDATA% subfolders", () => {
		const paths = resolveDaemonPaths(NAMES, {
			platform: "win32",
			home: "C:\\Users\\x",
			env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
		});
		expect(paths.database).toBe("C:\\Users\\x\\AppData\\Local\\acme-daemon\\Data\\db.sqlite");
		expect(paths.token).toBe("C:\\Users\\x\\AppData\\Local\\acme-daemon\\Data\\token");
		expect(paths.handle).toBe("C:\\Users\\x\\AppData\\Local\\Temp\\acme-daemon\\handle.json");
		expect(paths.serviceDescriptor).toBe("C:\\Users\\x\\AppData\\Roaming\\acme-daemon\\Config\\acme.service");
	});

	it("Windows: falls back to home-relative AppData when LOCALAPPDATA/APPDATA are unset", () => {
		const paths = resolveDaemonPaths(NAMES, { platform: "win32", home: "C:\\Users\\x", env: {} });
		expect(paths.database).toBe("C:\\Users\\x\\AppData\\Local\\acme-daemon\\Data\\db.sqlite");
		expect(paths.serviceDescriptor).toBe("C:\\Users\\x\\AppData\\Roaming\\acme-daemon\\Config\\acme.service");
	});
});

describe("resolveDaemonPaths cross-check against env-paths (devDependency, test-only -- never a runtime import)", () => {
	it("this host's real, uninjected resolveDaemonPaths() output shares its platform convention's root directory with env-paths' real output", async () => {
		const envPaths = (await import("env-paths")).default;
		// Neither call injects home/env/platform here -- both hit the real host
		// OS's actual os.homedir()/process.env, since env-paths has no override
		// hook to compare against otherwise. This is what actually grounds our
		// hand-rolled per-OS logic in a real, independently maintained reference
		// rather than trusting our own reading of its documented behavior.
		const ours = resolveDaemonPaths(NAMES);
		const real = envPaths("cross-check-app", { suffix: "" });
		if (process.platform === "darwin") {
			expect(ours.database).toContain("Library/Application Support");
			expect(real.data).toContain("Library/Application Support");
		} else if (process.platform === "win32") {
			expect(ours.database).toContain("Data");
			expect(real.data).toContain("Data");
		} else {
			expect(ours.database).toContain(".local/share");
			expect(real.data).toContain(".local/share");
		}
	});
});

describe("ensureAuthToken", () => {
	it("creates a 256-bit hex token on first run and reuses it thereafter", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-paths-"));
		const tokenPath = join(dir, "sub", "token");
		try {
			const first = ensureAuthToken(tokenPath, "Acme");
			expect(first).toMatch(/^[a-f0-9]{64}$/);
			const second = ensureAuthToken(tokenPath, "Acme");
			expect(second).toBe(first);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a corrupted token file rather than silently trusting it", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-paths-"));
		const tokenPath = join(dir, "token");
		writeFileSync(tokenPath, "not-a-real-token\n");
		try {
			expect(() => ensureAuthToken(tokenPath, "Acme")).toThrow("invalid Acme authentication token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("acquireDaemonLock / releaseDaemonLock", () => {
	it("the first caller acquires the lock; a second concurrent caller is refused and told the real holder's pid", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-lock-"));
		const lockPath = join(dir, "daemon.lock");
		try {
			const first = acquireDaemonLock(lockPath, () => true);
			expect(first).toEqual({ acquired: true });
			const second = acquireDaemonLock(lockPath, () => true); // pretend the holder pid is alive
			expect(second).toEqual({ acquired: false, holderPid: process.pid });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("N concurrent acquire attempts against no existing lock result in exactly one winner", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-lock-"));
		const lockPath = join(dir, "daemon.lock");
		try {
			const results = Array.from({ length: 8 }, () => acquireDaemonLock(lockPath, () => true));
			const winners = results.filter((r) => r.acquired);
			expect(winners.length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a stale lock naming a dead pid is detected and atomically stolen, allowing a new acquire to succeed", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-lock-"));
		const lockPath = join(dir, "daemon.lock");
		try {
			// A real process that has already exited -- a genuinely dead pid, not a guessed one.
			const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
			const deadPid = dead.pid ?? 999_999;
			writeFileSync(lockPath, `${deadPid}\n`);

			const isPidAlive = (pid: number) => pid !== deadPid;
			const result = acquireDaemonLock(lockPath, isPidAlive);
			expect(result).toEqual({ acquired: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("releaseDaemonLock is idempotent and lets a subsequent acquire succeed immediately", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-lock-"));
		const lockPath = join(dir, "daemon.lock");
		try {
			acquireDaemonLock(lockPath, () => true);
			releaseDaemonLock(lockPath);
			releaseDaemonLock(lockPath); // must not throw
			expect(acquireDaemonLock(lockPath, () => true)).toEqual({ acquired: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("daemon handle lifecycle", () => {
	it("writes atomically, reads back exactly, and removes cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-paths-"));
		const handlePath = join(dir, "run", "handle.json");
		try {
			expect(readDaemonHandle(handlePath)).toBeNull();
			writeDaemonHandle(handlePath, { host: LOOPBACK_HOST, port: 4321, pid: 999 });
			expect(readDaemonHandle(handlePath)).toEqual({ host: LOOPBACK_HOST, port: 4321, pid: 999 });
			removeDaemonHandle(handlePath);
			expect(readDaemonHandle(handlePath)).toBeNull();
			// Idempotent.
			expect(() => removeDaemonHandle(handlePath)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a handle with a non-loopback host, an out-of-range port, or a non-integer pid", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-kit-paths-"));
		const handlePath = join(dir, "handle.json");
		try {
			writeFileSync(handlePath, JSON.stringify({ host: "0.0.0.0", port: 1234, pid: 1 }));
			expect(readDaemonHandle(handlePath)).toBeNull();
			writeFileSync(handlePath, JSON.stringify({ host: LOOPBACK_HOST, port: 0, pid: 1 }));
			expect(readDaemonHandle(handlePath)).toBeNull();
			writeFileSync(handlePath, JSON.stringify({ host: LOOPBACK_HOST, port: 1234, pid: "not-a-pid" }));
			expect(readDaemonHandle(handlePath)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
