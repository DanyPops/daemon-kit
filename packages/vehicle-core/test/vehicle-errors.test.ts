import { describe, expect, it } from "bun:test";
import { boundedCauseMessage, defineErrorMapping, VehicleError } from "../src/vehicle-errors.ts";

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

describe("defineErrorMapping", () => {
	class MissingWidgetError extends Error {}
	class StaleWidgetError extends Error {}

	const mapError = defineErrorMapping([
		{ errorClass: MissingWidgetError, category: "not_found", code: "widget-not-found" },
		{ errorClass: StaleWidgetError, category: "conflict", code: "stale-widget" },
	]);

	it("passes an existing VehicleError through unchanged", async () => {
		const original = new VehicleError("already-mapped", "already mapped", { category: "authorization" });
		await expect(mapError(() => Promise.reject(original))).rejects.toBe(original);
	});

	it("maps a matching error class while preserving its message", async () => {
		const failure = await mapError(() => Promise.reject(new MissingWidgetError("widget 42 is missing"))).catch(
			(error: unknown) => (error as VehicleError).toFailure(),
		);
		expect(failure).toEqual({
			code: "widget-not-found",
			category: "not_found",
			message: "widget 42 is missing",
			retryable: false,
		});
	});

	it("uses the configured fallback for an unmatched error", async () => {
		const unavailable = defineErrorMapping([], { fallbackCategory: "unavailable", fallbackCode: "backend-failed" });
		const failure = await unavailable(() => {
			throw new Error("backend is offline");
		}).catch((error: unknown) => (error as VehicleError).toFailure());
		expect(failure).toMatchObject({ code: "backend-failed", category: "unavailable", message: "backend is offline" });
	});

	it("supports predicate rules for status-carrying errors", async () => {
		const byStatus = defineErrorMapping([
			{
				matches: (error) => error instanceof Error && "status" in error && error.status === 403,
				category: "authorization",
				code: "operation-rejected",
			},
		]);
		const error = Object.assign(new Error("approval denied"), { status: 403 });
		const failure = await byStatus(() => Promise.reject(error)).catch((caught: unknown) => (caught as VehicleError).toFailure());
		expect(failure).toMatchObject({ code: "operation-rejected", category: "authorization", message: "approval denied" });
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
