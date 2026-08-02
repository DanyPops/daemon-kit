import { describe, expect, it } from "bun:test";
import { HmacApprovalAuthority, hashApprovalInput } from "../src/vehicle-approval-authority.ts";

function request(
	overrides: Partial<{ requestId: string; operationName: string; operationVersion: number; expiresAt: number; inputHash: string }> = {},
) {
	return {
		requestId: "req-1",
		operationName: "test.destructive",
		operationVersion: 1,
		expiresAt: Date.now() + 60_000,
		inputHash: hashApprovalInput({ value: "go" }),
		...overrides,
	};
}

describe("hashApprovalInput", () => {
	it("hashes identical input identically and different input differently", () => {
		expect(hashApprovalInput({ value: "go" })).toBe(hashApprovalInput({ value: "go" }));
		expect(hashApprovalInput({ value: "go" })).not.toBe(hashApprovalInput({ value: "stop" }));
	});
});

describe("HmacApprovalAuthority", () => {
	it("verifies a capability it minted for the exact operation/version/input", () => {
		const authority = new HmacApprovalAuthority();
		const req = request();
		const capability = authority.mint(req);
		expect(authority.verify(capability, req.operationName, req.operationVersion, req.inputHash)).toBe(true);
	});

	it("rejects a capability presented for a different operation name", () => {
		const authority = new HmacApprovalAuthority();
		const req = request();
		const capability = authority.mint(req);
		expect(authority.verify(capability, "test.other", req.operationVersion, req.inputHash)).toBe(false);
	});

	it("rejects a capability presented for a different operation version", () => {
		const authority = new HmacApprovalAuthority();
		const req = request();
		const capability = authority.mint(req);
		expect(authority.verify(capability, req.operationName, 2, req.inputHash)).toBe(false);
	});

	it("rejects a capability presented for a different input hash", () => {
		const authority = new HmacApprovalAuthority();
		const req = request();
		const capability = authority.mint(req);
		expect(authority.verify(capability, req.operationName, req.operationVersion, hashApprovalInput({ value: "different" }))).toBe(false);
	});

	it("rejects an expired capability", () => {
		const authority = new HmacApprovalAuthority();
		const req = request({ expiresAt: Date.now() - 1 });
		const capability = authority.mint(req);
		expect(authority.verify(capability, req.operationName, req.operationVersion, req.inputHash)).toBe(false);
	});

	it("rejects a malformed or tampered capability string", () => {
		const authority = new HmacApprovalAuthority();
		expect(authority.verify("not-a-real-capability", "test.destructive", 1, "hash")).toBe(false);
		expect(authority.verify("signed-capability", "test.destructive", 1, "hash")).toBe(false);

		const req = request();
		const capability = authority.mint(req);
		const [requestId, expiresAt] = capability.split(".");
		const tampered = `${requestId}.${expiresAt}.${"0".repeat(64)}`;
		expect(authority.verify(tampered, req.operationName, req.operationVersion, req.inputHash)).toBe(false);
	});

	it("is single-use -- a second verify() of the same capability fails even though it hasn't expired", () => {
		const authority = new HmacApprovalAuthority();
		const req = request();
		const capability = authority.mint(req);
		expect(authority.verify(capability, req.operationName, req.operationVersion, req.inputHash)).toBe(true);
		expect(authority.verify(capability, req.operationName, req.operationVersion, req.inputHash)).toBe(false);
	});

	it("two authorities with different secrets never accept each other's capabilities", () => {
		const a = new HmacApprovalAuthority();
		const b = new HmacApprovalAuthority();
		const req = request();
		const capability = a.mint(req);
		expect(b.verify(capability, req.operationName, req.operationVersion, req.inputHash)).toBe(false);
	});
});
