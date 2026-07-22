import { describe, expect, it } from "bun:test";
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "../src/http.ts";

describe("requireBearerToken", () => {
	it("accepts an exact Bearer match and rejects everything else", async () => {
		const good = new Request("http://x", { headers: { authorization: "Bearer secret" } });
		expect(requireBearerToken(good, "secret")).toBe(true);
		expect(requireBearerToken(new Request("http://x", { headers: { authorization: "Bearer wrong" } }), "secret")).toBe(false);
		expect(requireBearerToken(new Request("http://x"), "secret")).toBe(false);
		expect(requireBearerToken(new Request("http://x", { headers: { authorization: "secret" } }), "secret")).toBe(false);
	});
});

describe("response helpers", () => {
	it("jsonResponse/errorResponse round-trip through fetch's Response", async () => {
		const ok = jsonResponse({ a: 1 });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ a: 1 });

		const err = errorResponse("nope", 404);
		expect(err.status).toBe(404);
		expect(await err.json()).toEqual({ error: "nope" });
	});

	it("healthResponse reports ok + version, with room for daemon-specific extras", async () => {
		const res = healthResponse("1.2.3", { schema: 4 });
		expect(await res.json()).toEqual({ ok: true, version: "1.2.3", schema: 4 });
	});

	it("readyResponse is 200 when ready and 503 with a body when not", async () => {
		const ready = readyResponse(true);
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ ready: true });

		const notReady = readyResponse(false);
		expect(notReady.status).toBe(503);
		expect(await notReady.json()).toEqual({ error: "not ready" });
	});
});
