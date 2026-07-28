/**
 * Client counterpart to unix-rpc-server.ts's serveUnixRpc: speaks the same
 * one-line-JSON-request-in, one-line-JSON-response-out framing over a Unix
 * domain socket. Returns a Fetch-API-shaped function so it drops in
 * anywhere a fetch()-like transport is already expected (e.g.
 * AuthenticatedRpcClient's own `transport` option, or a vault client's
 * `fetchImpl`) -- callers never see the wire framing.
 *
 * No identity material to construct on this side. SO_PEERCRED (see
 * unix-peer-cred.ts) is entirely kernel-enforced against the connecting
 * process's real fd -- unlike a bearer-token transport, this client never
 * holds, reads, or presents any secret at all. Opening the socket is
 * itself the proof of identity; the server resolves who's calling from
 * the connection, never from anything this module sends.
 */

export interface UnixRpcClientOptions {
	path: string;
	/** A hung or dead server should never block a caller forever. Default 5000ms. */
	timeoutMs?: number;
}

interface WireResponse {
	status: number;
	headers?: Record<string, string>;
	body?: string | null;
}

async function requestToWireLine(request: Request): Promise<string> {
	const url = new URL(request.url);
	const headers: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		headers[key] = value;
	});
	const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
	return `${JSON.stringify({ method: request.method, path: `${url.pathname}${url.search}`, headers, body: body ?? null })}\n`;
}

/**
 * Builds a `(request: Request) => Promise<Response>` transport that sends
 * one request over a fresh connection to `path` and resolves with the
 * server's one response, then closes -- matching serveUnixRpc's own
 * one-request-per-connection contract (no keep-alive, no pipelining).
 */
export function connectUnixRpc(options: UnixRpcClientOptions): (request: Request) => Promise<Response> {
	const timeoutMs = options.timeoutMs ?? 5000;

	return async function fetchOverUnixSocket(request: Request): Promise<Response> {
		const wireLine = await requestToWireLine(request);

		return new Promise<Response>((resolve, reject) => {
			let buffered = "";
			let settled = false;

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};

			const timer = setTimeout(() => {
				settle(() => reject(new Error(`unix RPC call to ${options.path} timed out after ${timeoutMs}ms`)));
			}, timeoutMs);

			Bun.connect({
				unix: options.path,
				socket: {
					open(socket) {
						socket.write(wireLine);
					},
					data(socket, chunk) {
						buffered += chunk.toString("utf8");
						const newlineIndex = buffered.indexOf("\n");
						if (newlineIndex === -1) return;
						settle(() => {
							try {
								const wireResponse = JSON.parse(buffered.slice(0, newlineIndex)) as WireResponse;
								resolve(new Response(wireResponse.body ?? null, { status: wireResponse.status, headers: wireResponse.headers }));
							} catch (err) {
								reject(err instanceof Error ? err : new Error(String(err)));
							}
						});
						socket.end();
					},
					close() {
						settle(() => reject(new Error(`unix RPC connection to ${options.path} closed before a response was received`)));
					},
					error(_socket, err) {
						settle(() => reject(err));
					},
				},
			}).catch((err: unknown) => {
				settle(() => reject(err instanceof Error ? err : new Error(String(err))));
			});
		});
	};
}
