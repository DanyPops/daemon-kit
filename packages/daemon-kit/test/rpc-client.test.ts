import { describe, expect, it } from "bun:test";
import { AuthenticatedRpcClient, type FetchTransport } from "../src/rpc-client.ts";

type Ops = { "a.b": { x: number } };
type Outs = { "a.b": { y: number } };

function fakeTransport(handler: (request: Request) => Promise<Response> | Response): FetchTransport {
	return async (request) => handler(request);
}

describe("AuthenticatedRpcClient", () => {
	it("sends the Bearer token and op/input body, and unwraps result", async () => {
		const seen: { auth: string | null; body: unknown } = { auth: null, body: undefined };
		const client = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(async (req) => {
				seen.auth = req.headers.get("authorization");
				seen.body = await req.json();
				return Response.json({ result: { y: 2 } });
			}),
		});
		const out = await client.call("a.b", { x: 1 });
		expect(seen.auth).toBe("Bearer tok");
		expect(seen.body).toEqual({ op: "a.b", input: { x: 1 } });
		expect(out).toEqual({ y: 2 });
	});

	it("call() throws the server's error message on a non-ok response", async () => {
		const client = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(() => Response.json({ error: "boom" }, { status: 400 })),
		});
		await expect(client.call("a.b", { x: 1 })).rejects.toThrow("boom");
	});

	it("call() falls back to a labeled generic error when the server sends none", async () => {
		const client = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(() => new Response("{}", { status: 500 })),
		});
		await expect(client.call("a.b", { x: 1 })).rejects.toThrow("Acme operation failed with HTTP 500");
	});

	it("operations() lists discoverable ops", async () => {
		const client = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(() => Response.json({ operations: ["a.b"] })),
		});
		expect(await client.operations()).toEqual(["a.b"]);
	});

	it("ready() returns false on 503 without throwing, and throws on other failures", async () => {
		const client503 = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(() => new Response(null, { status: 503 })),
		});
		expect(await client503.ready()).toBe(false);

		const client500 = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(() => new Response(null, { status: 500 })),
		});
		await expect(client500.ready()).rejects.toThrow("Acme readiness check failed with HTTP 500");
	});

	it("health() validates ok===true and a string version, not just HTTP status", async () => {
		const client = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(() => Response.json({ ok: true, version: "1.0.0" })),
		});
		expect(await client.health()).toEqual({ ok: true, version: "1.0.0" });

		const malformed = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			transport: fakeTransport(() => Response.json({ ok: true })), // missing version
		});
		await expect(malformed.health()).rejects.toThrow("Acme health check failed");
	});

	it("uses a custom opsPath when provided", async () => {
		const seen = { path: "" };
		const client = new AuthenticatedRpcClient<keyof Ops & string, Ops, Outs>("http://x", "tok", {
			label: "Acme",
			opsPath: "/custom/ops",
			transport: fakeTransport((req) => { seen.path = new URL(req.url).pathname; return Response.json({ result: { y: 1 } }); }),
		});
		await client.call("a.b", { x: 1 });
		expect(seen.path).toBe("/custom/ops");
	});
});
