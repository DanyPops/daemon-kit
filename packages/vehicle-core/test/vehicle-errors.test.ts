import { describe, expect, it } from "bun:test";
import { boundedCauseMessage, VehicleError } from "../src/vehicle-errors.ts";

describe("VehicleError.toFailure()", () => {
	it("omits causeMessage entirely when constructed without a cause -- no behavior change for the common case", () => {
		const error = new VehicleError("not-found", "no such thing", { category: "not_found" });
		expect(error.toFailure()).toEqual({ code: "not-found", category: "not_found", message: "no such thing", retryable: false });
	});

	it("omits causeMessage even with a cause present, unless exposeCause is explicitly set -- secure by default", () => {
		const error = new VehicleError("handler-failed", "tasks.create@1 handler failed", {
			category: "internal",
			cause: new Error("credential=secret"),
		});
		expect(error.toFailure().causeMessage).toBeUndefined();
	});

	it("includes the underlying cause's own message once exposeCause is explicitly true", () => {
		const error = new VehicleError("handler-failed", "tasks.create@1 handler failed", {
			category: "internal",
			cause: new Error("column 'title' is required"),
			exposeCause: true,
		});
		expect(error.toFailure().causeMessage).toBe("column 'title' is required");
	});

	it("bounds an oversized cause message instead of forwarding an unbounded payload onto the wire", () => {
		const huge = "x".repeat(10_000);
		const error = new VehicleError("handler-failed", "op failed", { category: "internal", cause: new Error(huge), exposeCause: true });
		expect(error.toFailure().causeMessage?.length).toBe(500);
	});

	it("extracts a message from a string cause too, not just a real Error instance", () => {
		const error = new VehicleError("handler-failed", "op failed", {
			category: "internal",
			cause: "raw string cause",
			exposeCause: true,
		});
		expect(error.toFailure().causeMessage).toBe("raw string cause");
	});

	it("omits causeMessage for a cause with no usable message (e.g. a non-Error, non-string thrown value), even with exposeCause true", () => {
		const error = new VehicleError("handler-failed", "op failed", { category: "internal", cause: { weird: true }, exposeCause: true });
		expect(error.toFailure().causeMessage).toBeUndefined();
	});
});

describe("boundedCauseMessage", () => {
	it("returns undefined for undefined/null", () => {
		expect(boundedCauseMessage(undefined)).toBeUndefined();
		expect(boundedCauseMessage(null)).toBeUndefined();
	});

	it("returns undefined for an Error with an empty message", () => {
		expect(boundedCauseMessage(new Error(""))).toBeUndefined();
	});
});
