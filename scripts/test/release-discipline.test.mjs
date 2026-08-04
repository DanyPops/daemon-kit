import { describe, expect, it } from "bun:test";
import { enforceReleaseDiscipline, findBreakingTypeCandidates } from "../check-release-discipline.mjs";

describe("release discipline", () => {
	it("detects exported declaration removal and required-field additions or renames", () => {
		const candidates = findBreakingTypeCandidates(`
-export interface RemovedPort {}
 export interface ServiceSpec {
-	readonly descriptorPath: string;
+	readonly handlePath: string;
+	readonly version: string;
 }
`);
		expect(candidates).toEqual({
			removedDeclarations: ["RemovedPort"],
			removedProperties: ["descriptorPath"],
			addedRequiredProperties: ["handlePath", "version"],
		});
	});

	it("ignores formatting-only declaration and property rewrites", () => {
		const candidates = findBreakingTypeCandidates(`
-export type Identity = Base & { readonly url?: never };
+export type Identity = (Base & { readonly url?: never });
-	readonly name: string;
+	readonly name: BrandedName;
`);
		expect(candidates).toEqual({ removedDeclarations: [], removedProperties: [], addedRequiredProperties: [] });
	});

	it("requires an explicit pre-1.0 breaking note", () => {
		const candidates = { removedDeclarations: [], removedProperties: ["descriptorPath"], addedRequiredProperties: ["handlePath"] };
		expect(() =>
			enforceReleaseDiscipline({ previousVersion: "0.16.0", currentVersion: "0.17.0", candidates, releaseMessage: "feat: rename field" }),
		).toThrow("BREAKING CHANGE:");
		expect(() =>
			enforceReleaseDiscipline({
				previousVersion: "0.16.0",
				currentVersion: "0.17.0",
				candidates,
				releaseMessage: "feat: rename field\n\nBREAKING CHANGE: descriptorPath is now handlePath",
			}),
		).not.toThrow();
	});

	it("requires a major bump after 1.0", () => {
		const candidates = { removedDeclarations: ["OldPort"], removedProperties: [], addedRequiredProperties: [] };
		expect(() =>
			enforceReleaseDiscipline({ previousVersion: "1.4.0", currentVersion: "1.5.0", candidates, releaseMessage: "BREAKING CHANGE: removed" }),
		).toThrow("major version bump");
	});
});
