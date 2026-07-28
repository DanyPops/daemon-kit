/**
 * Serves a Fetch-API-shaped `(request: Request) => Promise<Response>` handler
 * over a Unix domain socket, with the connecting process's real kernel-verified
 * peer credential (SO_PEERCRED) passed alongside every request.
 *
 * Deliberately not a real HTTP/1.1 server: Bun's own Bun.serve/node:http expose
 * no peer credentials at all for a unix-socket connection (confirmed directly --
 * server.requestIP() returns null, req.socket has no usable fd), so reaching an
 * app's existing route logic here needs its own transport. A full HTTP/1.1
 * reimplementation is unwarranted scope for what is a small internal RPC surface
 * with no streaming, no chunked encoding, and no keep-alive requirement -- one
 * newline-delimited JSON request per connection, one newline-delimited JSON
 * response, then close.
 */
import { getPeerCredential, rawSocketFd, type PeerCredential } from "./unix-peer-cred.ts";

interface WireRequest {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string | null;
}

interface WireResponse {
	status: number;
	headers?: Record<string, string>;
	body?: string | null;
}

export interface UnixRpcServerOptions {
	path: string;
	/** Mode for the created socket file; defaults to 0600 (owner-only), matching daemon-kit's other owner-only-by-default surfaces. */
	mode?: number;
	handler: (request: Request, peer: PeerCredential) => Promise<Response>;
	/** Called for a genuinely unexpected failure (peer-cred lookup failing, a handler throwing); never silently swallowed. */
	onError?: (err: unknown) => void;
}

export interface UnixRpcServer {
	stop(): void;
}

function writeFrame(socket: { write(data: string): void; end(): void }, response: WireResponse): void {
	socket.write(`${JSON.stringify(response)}\n`);
	socket.end();
}

async function buildRequest(wire: WireRequest): Promise<Request> {
	// The host is meaningless for a Unix socket -- every route handler in practice only
	// ever inspects pathname/search, never origin, so any well-formed placeholder does.
	const url = new URL(wire.path, "http://unix-rpc.local");
	return new Request(url.href, {
		method: wire.method,
		headers: wire.headers,
		body: wire.body ?? undefined,
	});
}

async function frameResponse(response: Response): Promise<WireResponse> {
	const body = await response.text();
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return { status: response.status, headers, body: body.length > 0 ? body : null };
}

export function serveUnixRpc(options: UnixRpcServerOptions): UnixRpcServer {
	const server = Bun.listen({
		unix: options.path,
		socket: {
			open(socket) {
				const fd = rawSocketFd(socket);
				let peer: PeerCredential;
				try {
					if (fd === undefined) throw new Error("accepted unix socket exposed no usable fd");
					peer = getPeerCredential(fd);
				} catch (err) {
					options.onError?.(err);
					socket.end();
					return;
				}
				// @ts-expect-error -- stash per-connection state; Bun's socket data slot is `unknown` by design.
				socket.data = { peer, buffered: "" };
			},
			async data(socket, chunk) {
				// @ts-expect-error -- see open() above.
				const state = socket.data as { peer: PeerCredential; buffered: string };
				state.buffered += chunk.toString("utf8");
				const newlineIndex = state.buffered.indexOf("\n");
				if (newlineIndex === -1) return; // wait for the rest of the line

				const line = state.buffered.slice(0, newlineIndex);
				let wireRequest: WireRequest;
				try {
					wireRequest = JSON.parse(line) as WireRequest;
				} catch (err) {
					options.onError?.(err);
					writeFrame(socket, { status: 400, body: JSON.stringify({ error: "malformed request line" }) });
					return;
				}

				try {
					const request = await buildRequest(wireRequest);
					const response = await options.handler(request, state.peer);
					writeFrame(socket, await frameResponse(response));
				} catch (err) {
					options.onError?.(err);
					writeFrame(socket, { status: 500, body: JSON.stringify({ error: "internal error" }) });
				}
			},
			close() {},
		},
	});

	try {
		require("node:fs").chmodSync(options.path, options.mode ?? 0o600);
	} catch (err) {
		options.onError?.(err);
	}

	return {
		stop() {
			server.stop(true);
		},
	};
}
