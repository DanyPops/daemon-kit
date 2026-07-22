/**
 * Shared HTTP scaffolding for a daemon's `fetch(request): Promise<Response>`
 * handler: Bearer-token auth and the JSON/health response shapes that were
 * hand-rolled, verbatim, in every daemon's service.ts.
 *
 * No routing framework here on purpose -- each daemon has a handful of
 * routes; a router/RPC framework would add more surface than the ~10 lines
 * per daemon it would replace (see the off-the-shelf-modules research this
 * was scoped against).
 */

export function requireBearerToken(request: Request, token: string): boolean {
	return request.headers.get("authorization") === `Bearer ${token}`;
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return Response.json(value, init);
}

export function errorResponse(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

export const UNAUTHORIZED_RESPONSE: Response = errorResponse("unauthorized", 401);

export function healthResponse(version: string, extra: Record<string, unknown> = {}): Response {
	return jsonResponse({ ok: true, version, ...extra });
}

export function readyResponse(ready: boolean): Response {
	return ready ? jsonResponse({ ready: true }) : errorResponse("not ready", 503);
}
