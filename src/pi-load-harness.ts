/**
 * Verifies a module loads safely under every path Pi's own extension loader
 * can take. Pi documents that extensions are loaded via jiti, transpiling
 * TypeScript without a build step -- and jiti has a real, demonstrated
 * failure class importing a *dependency's* raw, unbuilt TypeScript: pi's own
 * loader vendors a native-modules escape hatch for exactly this ("pure-CJS
 * packages whose module-level Maps must live in the global V8 realm, not
 * jiti's transform scope"), and a consumer daemon in this house hit the same
 * failure mode importing its own daemon package's raw TS from its extension.
 *
 * Three paths are checked because they are the three a real Pi session can
 * take: plain native ESM `import()` (Node's own resolver, no jiti at all),
 * jiti with tryNative:false (jiti transpiles and evaluates everything
 * itself -- the path most exposed to the Map-realm failure), and jiti with
 * tryNative:true (jiti prefers Node's native loader per-module, falling back
 * to its own transform only when needed).
 */
import { pathToFileURL } from "node:url";

/**
 * Packages whose module-level state (e.g. a Map literal) must be evaluated
 * in the real V8 realm, not jiti's transform scope, or later `instanceof`/
 * identity checks against that state silently fail. Vendored from Pi's own
 * extension loader; kept in sync manually since jiti resolution is loader
 * policy, not something a dependency can introspect at runtime.
 */
export const JITI_NATIVE_MODULES: readonly string[] = [
	"jsdom",
	"lru-cache",
	"@asamuzakjp/css-color",
	"css-tree",
	"@asamuzakjp/dom-selector",
	"nwsapi",
];

export type PiLoadPath = "native-esm" | "jiti-try-native-false" | "jiti-try-native-true";

export interface PiLoadPathResult {
	path: PiLoadPath;
	ok: boolean;
	error?: string;
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadViaNativeEsm(modulePath: string): Promise<PiLoadPathResult> {
	try {
		await import(pathToFileURL(modulePath).href);
		return { path: "native-esm", ok: true };
	} catch (error) {
		return { path: "native-esm", ok: false, error: toMessage(error) };
	}
}

async function loadViaJiti(modulePath: string, tryNative: boolean, path: PiLoadPath): Promise<PiLoadPathResult> {
	try {
		const { createJiti } = (await import("jiti")) as typeof import("jiti");
		const jiti = createJiti(pathToFileURL(modulePath).href, {
			moduleCache: false,
			tryNative,
			nativeModules: [...JITI_NATIVE_MODULES],
		});
		await jiti.import(modulePath);
		return { path, ok: true };
	} catch (error) {
		return { path, ok: false, error: toMessage(error) };
	}
}

/**
 * Loads `modulePath` (an absolute path to a .ts/.js module) through all
 * three Pi extension load paths and reports one result per path. Never
 * throws itself -- a failing path is a result with ok:false, so a caller can
 * assert on every path in one place instead of the first failure aborting
 * the others.
 */
export async function verifyLoadableUnderPi(modulePath: string): Promise<PiLoadPathResult[]> {
	return Promise.all([
		loadViaNativeEsm(modulePath),
		loadViaJiti(modulePath, false, "jiti-try-native-false"),
		loadViaJiti(modulePath, true, "jiti-try-native-true"),
	]);
}
