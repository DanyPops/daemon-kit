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

/** Raw bearer token from the Authorization header, or undefined if absent/malformed. For callers that need to look the token up (e.g. against a registry) rather than compare it to one fixed value. */
export function extractBearerToken(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return undefined;
	const token = header.slice("Bearer ".length);
	return token.length > 0 ? token : undefined;
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
