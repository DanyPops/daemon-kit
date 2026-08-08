import { describe, expect, it } from "bun:test";
import { neutralizeEmbeddedFullResets } from "../src/vehicle-render.ts";

describe("neutralizeEmbeddedFullResets", () => {
	it("rewrites a full SGR reset into every reset except background", () => {
		expect(neutralizeEmbeddedFullResets("\x1b[0m")).toBe("\x1b[22;23;24;25;27;28;29;39m");
	});

	it("rewrites a full reset embedded in the middle of a line (the actual bug: this used to kill an outer Box background)", () => {
		const input = "before\x1b[0mafter";
		expect(neutralizeEmbeddedFullResets(input)).toBe("before\x1b[22;23;24;25;27;28;29;39mafter");
	});

	it("rewrites a full reset even when it sits at the true end of the string", () => {
		// Deliberately not left alone: once this string is concatenated into a larger
		// line (e.g. segments.join(" ") in renderVehicleCall), "the end" moves --
		// leaving a trailing reset unsanitized would just move the bug, not fix it.
		const input = "trailing\x1b[0m";
		expect(neutralizeEmbeddedFullResets(input)).toBe("trailing\x1b[22;23;24;25;27;28;29;39m");
	});

	it("rewrites every occurrence when a full reset appears more than once", () => {
		const input = "\x1b[0mone\x1b[0mtwo\x1b[0m";
		const rewritten = "\x1b[22;23;24;25;27;28;29;39m";
		expect(neutralizeEmbeddedFullResets(input)).toBe(`${rewritten}one${rewritten}two${rewritten}`);
	});

	it("leaves text with no full reset unchanged", () => {
		const input = "\x1b[38;2;238;0;0mred\x1b[39m plain \x1b[49m";
		expect(neutralizeEmbeddedFullResets(input)).toBe(input);
	});

	it("leaves plain, uncolored text unchanged", () => {
		expect(neutralizeEmbeddedFullResets("no ansi codes here")).toBe("no ansi codes here");
	});
});
