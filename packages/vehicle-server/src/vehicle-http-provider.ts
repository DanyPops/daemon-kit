/**
 * Authenticated HTTP surface for a VehicleRegistry -- lets a host expose
 * its Vehicle operations to a RemoteVehicleClient (@danypops/vehicle-client's
 * ./http export), built on this package's own generic Bearer-auth/JSON
 * helpers (./rpc-http, formerly daemon-kit's http.ts -- absorbed here since
 * Vehicle IS the daemon substrate now, not a separate consumer of it).
 *
 * Exported as this package's ./http subpath, kept separate from the root
 * (VehicleRegistry) export -- a consumer that only builds/tests a registry
 * has no reason to pull in HTTP request/response plumbing.
 * Daemon-side raw TypeScript, not part of any Pi-loaded compiled surface.
 * Three routes:
 *   GET  /vehicle/manifest        -> the registry's current VehicleManifest
 *   POST /vehicle/invoke          -> invoke one operation; JSON by default,
 *                                    Server-Sent Events when the request
 *                                    sends `Accept: text/event-stream`
 *                                    (needed for progress -- a plain JSON
 *                                    response can only carry a final result)
 *   POST /vehicle/cancel          -> best-effort cancellation of a still-
 *                                    in-flight operationId
 *
 * Local/HTTP parity: every VehicleInvocationOptions field LocalVehicleClient
 * accepts is threaded through the wire body; the same VehicleError shape
 * comes back as a JSON `error` field with an HTTP status derived from its
 * category, so RemoteVehicleClient reconstructs the identical VehicleError
 * a local caller would have seen.
 */
import { randomUUID } from "node:crypto";
import type { VehicleFailure, VehicleFailureCategory, VehicleInvocationOptions, VehiclePrincipal } from "@danypops/vehicle-core";
import { VehicleError } from "@danypops/vehicle-core";
import { errorResponse, jsonResponse, requireBearerToken } from "./http.js";
import type { Logger } from "./logging.js";
import type { VehicleRegistry } from "./vehicle-registry.js";

const UNAUTHORIZED_RESPONSE: Response = errorResponse("unauthorized", 401);

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface VehicleHttpProviderOptions {
	registry: VehicleRegistry;
	token: string;
	/**
	 * Defaults to a no-op logger. Without one, a failed invocation is sanitized
	 * into a wire-safe VehicleFailure (code/category/message only, per this
	 * house's own "never leak internals over the wire" discipline) and returned
	 * to the caller -- but the real cause (a handler's own thrown error,
	 * including its stack) is otherwise discarded the moment this function
	 * returns, unrecoverable from any log. Pass a real logger to keep it.
	 */
	logger?: Logger;
}

interface InvokeRequestBody {
	name?: unknown;
	version?: unknown;
	input?: unknown;
	operationId?: unknown;
	correlationId?: unknown;
	deadlineMs?: unknown;
	permissions?: unknown;
	principal?: unknown;
	idempotencyKey?: unknown;
	expectedRevision?: unknown;
	approvalCapability?: unknown;
}

function statusForCategory(category: VehicleFailureCategory): number {
	switch (category) {
		case "validation":
			return 400;
		case "not_found":
			return 404;
		case "conflict":
			return 409;
		case "authorization":
			return 403;
		case "capacity":
			return 413;
		case "timeout":
			return 504;
		case "cancelled":
			return 400;
		case "unavailable":
			return 503;
		default:
			return 500;
	}
}

function toFailurePayload(error: unknown): VehicleFailure {
	if (error instanceof VehicleError) return error.toFailure();
	return { code: "internal", category: "internal", message: "internal error", retryable: false };
}

/**
 * Logs the real, unsanitized cause of a failed invocation before it's
 * reduced to a wire-safe VehicleFailure -- the sanitized payload alone
 * (e.g. "tasks.complete@1 handler failed") names which operation failed but
 * never why; the operator-facing side of that same failure needs the
 * underlying error/stack this function preserves.
 */
function logInvokeFailure(logger: Logger, name: string, version: number, operationId: string, error: unknown): void {
	const cause = error instanceof VehicleError ? error.cause : undefined;
	logger.error(`vehicle invoke failed: ${name}@${version}`, {
		operationId,
		code: error instanceof VehicleError ? error.code : undefined,
		category: error instanceof VehicleError ? error.category : undefined,
		message: error instanceof Error ? error.message : String(error),
		cause: cause instanceof Error ? (cause.stack ?? cause.message) : cause !== undefined ? String(cause) : undefined,
	});
}

export function createVehicleHttpApp(options: VehicleHttpProviderOptions): { fetch(request: Request): Promise<Response> } {
	const inFlight = new Map<string, AbortController>();
	const logger = options.logger ?? NOOP_LOGGER;

	return {
		async fetch(request: Request): Promise<Response> {
			if (!requireBearerToken(request, options.token)) return UNAUTHORIZED_RESPONSE;
			const url = new URL(request.url);

			if (request.method === "GET" && url.pathname === "/vehicle/manifest") {
				return jsonResponse(options.registry.manifest());
			}

			if (request.method === "POST" && url.pathname === "/vehicle/cancel") {
				let body: { operationId?: unknown };
				try {
					body = (await request.json()) as { operationId?: unknown };
				} catch {
					return errorResponse("invalid JSON body", 400);
				}
				if (typeof body.operationId === "string") inFlight.get(body.operationId)?.abort();
				return new Response(null, { status: 204 });
			}

			if (request.method === "POST" && url.pathname === "/vehicle/invoke") {
				return handleInvoke(request, options.registry, inFlight, logger);
			}

			return errorResponse("not found", 404);
		},
	};
}

async function handleInvoke(
	request: Request,
	registry: VehicleRegistry,
	inFlight: Map<string, AbortController>,
	logger: Logger,
): Promise<Response> {
	let body: InvokeRequestBody;
	try {
		body = (await request.json()) as InvokeRequestBody;
	} catch {
		return errorResponse("invalid JSON body", 400);
	}
	if (typeof body.name !== "string" || typeof body.version !== "number") {
		return errorResponse("name and version are required", 400);
	}

	const operationId = typeof body.operationId === "string" && body.operationId.trim() ? body.operationId : randomUUID();
	const controller = new AbortController();
	inFlight.set(operationId, controller);

	const invocationOptions: VehicleInvocationOptions = {
		operationId,
		correlationId: typeof body.correlationId === "string" ? body.correlationId : undefined,
		signal: controller.signal,
		deadline: typeof body.deadlineMs === "number" ? Date.now() + body.deadlineMs : undefined,
		permissions: Array.isArray(body.permissions) ? (body.permissions as string[]) : undefined,
		principal: (body.principal as VehiclePrincipal | undefined) ?? undefined,
		idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
		expectedRevision: body.expectedRevision as string | number | undefined,
		approvalCapability: typeof body.approvalCapability === "string" ? body.approvalCapability : undefined,
	};

	const wantsStream = (request.headers.get("accept") ?? "").includes("text/event-stream");

	if (wantsStream) {
		return streamInvoke(registry, body.name, body.version, body.input, invocationOptions, logger, () => inFlight.delete(operationId));
	}

	try {
		const output = await registry.invoke(body.name, body.version, body.input, invocationOptions);
		return jsonResponse({ output, operationId });
	} catch (error) {
		logInvokeFailure(logger, body.name, body.version, operationId, error);
		const failure = toFailurePayload(error);
		return jsonResponse({ error: failure, operationId }, { status: statusForCategory(failure.category) });
	} finally {
		inFlight.delete(operationId);
	}
}

function streamInvoke(
	registry: VehicleRegistry,
	name: string,
	version: number,
	input: unknown,
	invocationOptions: VehicleInvocationOptions,
	logger: Logger,
	cleanup: () => void,
): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const withProgress: VehicleInvocationOptions = {
				...invocationOptions,
				onProgress: (progress) => controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`)),
			};
			registry.invoke(name, version, input, withProgress).then(
				(output) => {
					controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify({ output })}\n\n`));
					controller.close();
					cleanup();
				},
				(error: unknown) => {
					logInvokeFailure(logger, name, version, invocationOptions.operationId ?? "unknown", error);
					controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(toFailurePayload(error))}\n\n`));
					controller.close();
					cleanup();
				},
			);
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
