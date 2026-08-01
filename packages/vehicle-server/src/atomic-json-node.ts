/**
 * Real node:fs/promises-backed AtomicJsonFsAdapter -- vehicle-core's
 * atomic-json module stays fs-free itself (see its own doc comment), so
 * every real consumer needs this one adapter instead of hand-rolling the
 * same four-method wrapper. Vehicle Jobs' and Vehicle Watchers' own
 * state-persistence code both use this.
 */
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { AtomicJsonFsAdapter } from "@danypops/vehicle-core";

export function createNodeAtomicJsonFsAdapter(): AtomicJsonFsAdapter {
	return {
		writeFile: (path, data) => writeFile(path, data, "utf8"),
		rename: (oldPath, newPath) => rename(oldPath, newPath),
		unlink: (path) => unlink(path),
		readFile: (path) => readFile(path, "utf8"),
	};
}
