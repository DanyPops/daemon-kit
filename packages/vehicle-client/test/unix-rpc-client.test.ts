import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveUnixRpc } from "@danypops/vehicle-server/unix-rpc-server";
import { connectUnixRpc } from "../src/unix-rpc-client.ts";

function socketPath(): string {
	return join(tmpdir(), `daemon-kit-unix-rpc-client-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

describe("connectUnixRpc", () => {
	it("round-trips a real GET through a real serveUnixRpc server, method/path/response intact", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async (request) => {
				expect(request.method).toBe("GET");
				expect(new URL(request.url).pathname).toBe("/whoami");
				return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
			},
		});
		try {
			const transport = connectUnixRpc({ path });
			const response = await transport(new Request("http://unix.local/whoami"));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("forwards a POST body and headers, and returns the server's real status code", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async (request) => {
				expect(request.headers.get("authorization")).toBe("Bearer test-token");
				const body = await request.json();
				return new Response(JSON.stringify({ echoed: body }), { status: 201 });
			},
		});
		try {
			const transport = connectUnixRpc({ path });
			const response = await transport(
				new Request("http://unix.local/echo", {
					method: "POST",
					headers: { authorization: "Bearer test-token", "content-type": "application/json" },
					body: JSON.stringify({ hello: "world" }),
				}),
			);
			expect(response.status).toBe(201);
			expect(await response.json()).toEqual({ echoed: { hello: "world" } });
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("preserves query strings", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async (request) => new Response(JSON.stringify({ search: new URL(request.url).search }), { status: 200 }),
		});
		try {
			const transport = connectUnixRpc({ path });
			const response = await transport(new Request("http://unix.local/creds/github?extra=1"));
			expect(await response.json()).toEqual({ search: "?extra=1" });
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("surfaces a 404/401/etc from the server as a real Response, not a thrown error -- only transport failure throws", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async () => new Response(JSON.stringify({ error: "no credential stored" }), { status: 404 }),
		});
		try {
			const transport = connectUnixRpc({ path });
			const response = await transport(new Request("http://unix.local/creds/unknown-backend"));
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "no credential stored" });
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("rejects when no server is listening at the path (dead/absent socket) -- the caller's job to catch, matching every other transport-failure path in this codebase", async () => {
		const path = socketPath(); // never bound by any server
		const transport = connectUnixRpc({ path, timeoutMs: 500 });
		await expect(transport(new Request("http://unix.local/whoami"))).rejects.toThrow();
	});

	it("times out rather than hanging forever against a server that accepts but never responds", async () => {
		const path = socketPath();
		const server = Bun.listen({
			unix: path,
			socket: {
				open() {},
				data() {},
				close() {},
			},
		});
		try {
			const transport = connectUnixRpc({ path, timeoutMs: 200 });
			await expect(transport(new Request("http://unix.local/whoami"))).rejects.toThrow(/timed out/);
		} finally {
			server.stop(true);
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("serves multiple sequential calls correctly over fresh connections each time", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async (request) => new Response(JSON.stringify({ path: new URL(request.url).pathname }), { status: 200 }),
		});
		try {
			const transport = connectUnixRpc({ path });
			for (const p of ["/a", "/b", "/c"]) {
				const response = await transport(new Request(`http://unix.local${p}`));
				expect(await response.json()).toEqual({ path: p });
			}
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});
});
