/**
 * Typed authenticated loopback RPC client. Generalizes what was
 * byte-identical between web-spider-daemon's and jittor's client.ts
 * (same header comment admitting the duplication): POST {op, input} JSON
 * to a single dispatch endpoint with a Bearer token, plus /health and
 * /ready.
 */

export type FetchTransport = (request: Request) => Promise<Response>;

export interface AuthenticatedRpcClientOptions {
	/** e.g. "Web Spider" -- used only in error messages. */
	label: string;
	opsPath?: string;
	transport?: FetchTransport;
}

/**
 * @template OperationName union of operation name string literals
 * @template Inputs a `Record<OperationName, unknown>` mapping each operation to its input type
 * @template Outputs a `Record<OperationName, unknown>` mapping each operation to its output type
 */
export class AuthenticatedRpcClient<
	OperationName extends string,
	Inputs extends Record<OperationName, unknown>,
	Outputs extends Record<OperationName, unknown>,
> {
	private readonly opsPath: string;
	private readonly transport: FetchTransport;
	private readonly label: string;

	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		options: AuthenticatedRpcClientOptions,
	) {
		this.label = options.label;
		this.opsPath = options.opsPath ?? "/api/v1/ops";
		this.transport = options.transport ?? fetch;
	}

	private authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
		return this.transport(
			new Request(`${this.baseUrl}${path}`, {
				...init,
				headers: { ...init.headers, authorization: `Bearer ${this.token}` },
			}),
		);
	}

	async call<Name extends OperationName>(operation: Name, input: Inputs[Name]): Promise<Outputs[Name]> {
		const response = await this.authedRequest(this.opsPath, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ op: operation, input }),
		});
		const body = (await response.json()) as { result?: Outputs[Name]; error?: string };
		if (!response.ok) throw new Error(body.error ?? `${this.label} operation failed with HTTP ${response.status}`);
		return body.result as Outputs[Name];
	}

	async operations(): Promise<OperationName[]> {
		const response = await this.authedRequest(this.opsPath);
		const body = (await response.json()) as { operations?: OperationName[]; error?: string };
		if (!response.ok) throw new Error(body.error ?? `${this.label} discovery failed with HTTP ${response.status}`);
		return body.operations ?? [];
	}

	async ready(): Promise<boolean> {
		const response = await this.authedRequest("/ready");
		if (response.status === 503) return false;
		if (!response.ok) throw new Error(`${this.label} readiness check failed with HTTP ${response.status}`);
		return true;
	}

	async health(): Promise<{ ok: true; version: string }> {
		const response = await this.authedRequest("/health");
		const body = (await response.json()) as { ok?: boolean; version?: string; error?: string };
		if (!response.ok || body.ok !== true || typeof body.version !== "string") {
			throw new Error(body.error ?? `${this.label} health check failed`);
		}
		return { ok: true, version: body.version };
	}
}
