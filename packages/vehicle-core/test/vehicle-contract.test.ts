import { describe, expect, it } from "bun:test";
import { defineLooseObjectSchema, passthroughVehicleSchema } from "../src/vehicle-contract.ts";

describe("defineLooseObjectSchema", () => {
	it("rejects a non-object input", () => {
		const schema = defineLooseObjectSchema({ name: { type: "string" } });
		expect(schema.safeParse("nope")).toEqual({ success: false, issues: [{ path: [], message: "input must be an object" }] });
		expect(schema.safeParse(null)).toEqual({ success: false, issues: [{ path: [], message: "input must be an object" }] });
		expect(schema.safeParse(["array"])).toEqual({ success: false, issues: [{ path: [], message: "input must be an object" }] });
	});

	it("rejects a missing required field", () => {
		const schema = defineLooseObjectSchema({ id: { type: "string" }, name: { type: "string" } }, ["id"]);
		const result = schema.safeParse({ name: "x" });
		expect(result).toEqual({ success: false, issues: [{ path: ["id"], message: "id is required" }] });
	});

	it("accepts an object with every required field present", () => {
		const schema = defineLooseObjectSchema({ id: { type: "string" } }, ["id"]);
		expect(schema.safeParse({ id: "abc" })).toEqual({ success: true, value: { id: "abc" } });
	});

	it("enforces a declared enum for real, not just as documentation", () => {
		const schema = defineLooseObjectSchema({ status: { type: "string", enum: ["draft", "active"] } });
		expect(schema.safeParse({ status: "bogus" })).toEqual({
			success: false,
			issues: [{ path: ["status"], message: "status must be one of draft, active" }],
		});
		expect(schema.safeParse({ status: "draft" })).toEqual({ success: true, value: { status: "draft" } });
	});

	it("skips the enum check entirely when the field is absent (not required)", () => {
		const schema = defineLooseObjectSchema({ status: { type: "string", enum: ["draft", "active"] } });
		expect(schema.safeParse({})).toEqual({ success: true, value: {} });
	});

	it("produces additionalProperties: false JSON Schema metadata carrying the declared properties/required", () => {
		const schema = defineLooseObjectSchema({ id: { type: "string" } }, ["id"]);
		expect(schema.jsonSchema).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false });
	});
});

describe("passthroughVehicleSchema", () => {
	it("accepts any value unvalidated", () => {
		expect(passthroughVehicleSchema.safeParse({ anything: 1 })).toEqual({ success: true, value: { anything: 1 } });
		expect(passthroughVehicleSchema.safeParse("a string")).toEqual({ success: true, value: "a string" });
		expect(passthroughVehicleSchema.safeParse(null)).toEqual({ success: true, value: null });
	});
});
