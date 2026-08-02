import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { diagnostic } from "../fleet/diagnostic.js";
import type { NativeOperationOutcome } from "./service-manager.js";

const MAX_DESCRIPTOR_BYTES = 1024 * 1024;

export async function replaceFileAtomically(path: string, content: string): Promise<NativeOperationOutcome> {
	if (!isAbsolute(path)) {
		return {
			ok: false,
			diagnostics: [diagnostic("NATIVE_DESCRIPTOR_PATH_NOT_ABSOLUTE", "error", path, "descriptor path must be absolute")],
		};
	}
	if (Buffer.byteLength(content) > MAX_DESCRIPTOR_BYTES) {
		return {
			ok: false,
			diagnostics: [diagnostic("NATIVE_DESCRIPTOR_TOO_LARGE", "error", path, "descriptor exceeds 1 MiB")],
		};
	}
	const directory = dirname(path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporary, path);
		return { ok: true, diagnostics: [] };
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		return {
			ok: false,
			diagnostics: [
				diagnostic("NATIVE_DESCRIPTOR_WRITE_FAILED", "error", path, error instanceof Error ? error.message : String(error)),
			],
		};
	}
}
