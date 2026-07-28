import { describe, expect, it } from "bun:test";
import { statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveUnixRpc } from "../src/unix-rpc-server.ts";

function socketPath(): string {
	return join(tmpdir(), `daemon-kit-unix-rpc-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

const realUid = process.getuid?.();
if (realUid === undefined) throw new Error("process.getuid unavailable -- this suite requires a POSIX platform");

/** Sends one newline-delimited JSON request over `path` and returns the parsed response line. */
async function sendRequest(path: string, request: unknown): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let buffered = "";
	const client = await Bun.connect({
		unix: path,
		socket: {
			open(socket) {
				socket.write(`${JSON.stringify(request)}\n`);
			},
			data(_socket, chunk) {
				buffered += chunk.toString("utf8");
				const newlineIndex = buffered.indexOf("\n");
				if (newlineIndex !== -1) resolve(JSON.parse(buffered.slice(0, newlineIndex)));
			},
			close() {},
			error(_socket, err) {
				reject(err);
			},
		},
	});
	const result = await promise;
	client.end();
	return result;
}

describe("serveUnixRpc: socket file permissions", () => {
	it("defaults to owner-only (0600) -- an internal RPC socket has no reason to be group/world-accessible", async () => {
		const path = socketPath();
		const server = serveUnixRpc({ path, handler: async () => new Response(null, { status: 204 }) });
		try {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("honors an explicit mode override", async () => {
		const path = socketPath();
		const server = serveUnixRpc({ path, mode: 0o660, handler: async () => new Response(null, { status: 204 }) });
		try {
			expect(statSync(path).mode & 0o777).toBe(0o660);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});
});

describe("serveUnixRpc", () => {
	it("dispatches a framed request to the handler as a real Request object and returns its Response framed back", async () => {
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
			const response = await sendRequest(path, { method: "GET", path: "/whoami" });
			expect(response).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) });
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("passes the connecting process's real kernel-verified peer credential to the handler, not something the client can assert", async () => {
		const path = socketPath();
		const seenUid = Promise.withResolvers<number>();
		const server = serveUnixRpc({
			path,
			handler: async (_request, peer) => {
				seenUid.resolve(peer.uid);
				return new Response(null, { status: 204 });
			},
		});
		try {
			await sendRequest(path, { method: "GET", path: "/anything" });
			expect(await seenUid.promise).toBe(realUid);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("forwards a request body and headers through to the constructed Request", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async (request) => {
				expect(request.headers.get("authorization")).toBe("Bearer test-token");
				const body = await request.json();
				return new Response(JSON.stringify({ echoed: body }), { status: 200 });
			},
		});
		try {
			const response = (await sendRequest(path, {
				method: "POST",
				path: "/echo",
				headers: { authorization: "Bearer test-token" },
				body: JSON.stringify({ hello: "world" }),
			})) as { status: number; body: string };
			expect(JSON.parse(response.body)).toEqual({ echoed: { hello: "world" } });
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("responds with a clean 400 for a malformed request line instead of hanging or crashing the server", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async () => new Response(null, { status: 200 }),
		});
		try {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			let buffered = "";
			const client = await Bun.connect({
				unix: path,
				socket: {
					open(socket) {
						socket.write("not valid json at all\n");
					},
					data(_socket, chunk) {
						buffered += chunk.toString("utf8");
						const newlineIndex = buffered.indexOf("\n");
						if (newlineIndex !== -1) resolve(JSON.parse(buffered.slice(0, newlineIndex)));
					},
					close() {},
				},
			});
			const response = (await promise) as { status: number };
			client.end();
			expect(response.status).toBe(400);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("keeps serving later connections unaffected after one connection's handler throws", async () => {
		const path = socketPath();
		let callCount = 0;
		const server = serveUnixRpc({
			path,
			handler: async () => {
				callCount++;
				if (callCount === 1) throw new Error("boom");
				return new Response(null, { status: 204 });
			},
		});
		try {
			const first = (await sendRequest(path, { method: "GET", path: "/x" })) as { status: number };
			expect(first.status).toBe(500);
			const second = (await sendRequest(path, { method: "GET", path: "/x" })) as { status: number };
			expect(second.status).toBe(204);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("serves multiple sequential connections correctly, not just the first", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async (request) => new Response(JSON.stringify({ path: new URL(request.url).pathname }), { status: 200 }),
		});
		try {
			for (const p of ["/a", "/b", "/c"]) {
				const response = (await sendRequest(path, { method: "GET", path: p })) as { body: string };
				expect(JSON.parse(response.body)).toEqual({ path: p });
			}
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});
});
