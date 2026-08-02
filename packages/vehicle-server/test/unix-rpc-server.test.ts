import { describe, expect, it } from "bun:test";
import { rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../src/logging.ts";
import { getCurrentRpcCallId } from "../src/rpc-correlation.ts";
import { serveUnixRpc } from "../src/unix-rpc-server.ts";

function socketPath(): string {
	return join(tmpdir(), `daemon-kit-unix-rpc-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** A path whose parent directory doesn't exist yet -- proves serveUnixRpc creates it, matching daemon-kit's other file-writing helpers (writeDaemonHandle, ensureAuthToken). */
function socketPathInMissingDir(): string {
	return join(tmpdir(), `daemon-kit-unix-rpc-missing-dir-${process.pid}-${Math.random().toString(36).slice(2)}`, "admin.sock");
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

describe("serveUnixRpc: creates its own parent directory", () => {
	it("binds successfully even when the socket's parent directory does not exist yet", async () => {
		const path = socketPathInMissingDir();
		const server = serveUnixRpc({ path, handler: async () => new Response(null, { status: 204 }) });
		try {
			expect(statSync(path).isSocket()).toBe(true);
		} finally {
			server.stop();
			try {
				rmSync(dirname(path), { recursive: true, force: true });
			} catch {}
		}
	});

	it("binds successfully over a stale leftover socket file from an unclean previous shutdown (crash, SIGKILL, OOM)", async () => {
		const path = socketPath();
		writeFileSync(path, ""); // a plain leftover file at this path, not a live listener -- the realistic post-crash state
		const server = serveUnixRpc({ path, handler: async () => new Response(null, { status: 204 }) });
		try {
			expect(statSync(path).isSocket()).toBe(true);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});
});

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

describe("serveUnixRpc: per-call rpcCallId correlation", () => {
	it("the handler runs with a real, non-empty rpcCallId bound for the duration of its own call", async () => {
		const path = socketPath();
		const server = serveUnixRpc({
			path,
			handler: async () => new Response(JSON.stringify({ rpcCallId: getCurrentRpcCallId() }), { status: 200 }),
		});
		try {
			const response = (await sendRequest(path, { method: "GET", path: "/x" })) as { body: string };
			const { rpcCallId } = JSON.parse(response.body) as { rpcCallId: string | undefined };
			expect(typeof rpcCallId).toBe("string");
			expect(rpcCallId!.length).toBeGreaterThan(0);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("two concurrent calls each carry a different, stable-within-a-call rpcCallId, never leaking into a sibling call's log lines", async () => {
		const path = socketPath();
		const lines: string[] = [];
		const destination = {
			write: (chunk: string) => {
				lines.push(chunk);
				return true;
			},
		};
		const logger = createLogger("test-handler", { level: "debug", destination });

		const server = serveUnixRpc({
			path,
			handler: async (request) => {
				const delayMs = new URL(request.url).pathname === "/slow" ? 20 : 0;
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				logger.info("handled", { path: new URL(request.url).pathname });
				return new Response(null, { status: 204 });
			},
		});
		try {
			await Promise.all([sendRequest(path, { method: "GET", path: "/slow" }), sendRequest(path, { method: "GET", path: "/fast" })]);

			expect(lines).toHaveLength(2);
			const parsed = lines.map((line) => JSON.parse(line));
			const slow = parsed.find((entry) => entry.path === "/slow");
			const fast = parsed.find((entry) => entry.path === "/fast");
			expect(typeof slow.rpcCallId).toBe("string");
			expect(typeof fast.rpcCallId).toBe("string");
			expect(slow.rpcCallId).not.toBe(fast.rpcCallId);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});

	it("a log call several awaits deep inside the handler still carries its own call's rpcCallId, not a sibling's", async () => {
		const path = socketPath();
		const lines: string[] = [];
		const destination = {
			write: (chunk: string) => {
				lines.push(chunk);
				return true;
			},
		};
		const logger = createLogger("test-handler", { level: "debug", destination });

		async function deepHandlerChain(pathname: string): Promise<void> {
			await new Promise((resolve) => setTimeout(resolve, pathname === "/slow" ? 15 : 0));
			async function innerStep(): Promise<void> {
				await new Promise((resolve) => setTimeout(resolve, 1));
				logger.info("deep", { path: pathname });
			}
			await innerStep();
		}

		const server = serveUnixRpc({
			path,
			handler: async (request) => {
				await deepHandlerChain(new URL(request.url).pathname);
				return new Response(null, { status: 204 });
			},
		});
		try {
			await Promise.all([sendRequest(path, { method: "GET", path: "/slow" }), sendRequest(path, { method: "GET", path: "/fast" })]);

			const parsed = lines.map((line) => JSON.parse(line));
			const slow = parsed.find((entry) => entry.path === "/slow");
			const fast = parsed.find((entry) => entry.path === "/fast");
			expect(slow.rpcCallId).toBeTruthy();
			expect(fast.rpcCallId).toBeTruthy();
			expect(slow.rpcCallId).not.toBe(fast.rpcCallId);
		} finally {
			server.stop();
			try {
				unlinkSync(path);
			} catch {}
		}
	});
});
