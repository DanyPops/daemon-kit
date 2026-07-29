/**
 * Authenticated HTTP surface for a VehicleRegistry -- lets a daemon expose
 * its Vehicle operations to a RemoteVehicleClient (@danypops/vehicle-client's
 * ./http export) over the same Bearer-authenticated loopback transport
 * every other daemon-kit daemon already uses (@danypops/daemon-kit/http).
 *
 * Exported as this package's ./http subpath, kept separate from the root
 * (VehicleRegistry) export -- a consumer that only builds/tests a registry
 * has no reason to pull in HTTP request/response plumbing. Daemon-side
 * only: raw TypeScript, like daemon-kit's own daemon.ts/http.ts, not part
 * of any Pi-loaded compiled surface. Three routes:
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
import { errorResponse, jsonResponse, requireBearerToken, UNAUTHORIZED_RESPONSE } from "@danypops/daemon-kit/http";
import { VehicleError } from "@danypops/vehicle-core";
import type { VehicleFailure, VehicleFailureCategory, VehicleInvocationOptions, VehiclePrincipal } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "./vehicle-registry.js";

export interface VehicleHttpProviderOptions {
	registry: VehicleRegistry;
	token: string;
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
		case "internal":
		default:
			return 500;
	}
}

function toFailurePayload(error: unknown): VehicleFailure {
	if (error instanceof VehicleError) return error.toFailure();
	return { code: "internal", category: "internal", message: "internal error", retryable: false };
}

export function createVehicleHttpApp(options: VehicleHttpProviderOptions): { fetch(request: Request): Promise<Response> } {
	const inFlight = new Map<string, AbortController>();

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
				return handleInvoke(request, options.registry, inFlight);
			}

			return errorResponse("not found", 404);
		},
	};
}

async function handleInvoke(request: Request, registry: VehicleRegistry, inFlight: Map<string, AbortController>): Promise<Response> {
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
		return streamInvoke(registry, body.name, body.version, body.input, invocationOptions, () => inFlight.delete(operationId));
	}

	try {
		const output = await registry.invoke(body.name, body.version, body.input, invocationOptions);
		return jsonResponse({ output, operationId });
	} catch (error) {
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
					controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(toFailurePayload(error))}\n\n`));
					controller.close();
					cleanup();
				},
			);
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
