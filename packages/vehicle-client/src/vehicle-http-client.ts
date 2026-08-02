/**
 * A VehicleClient that talks to a remote daemon's @danypops/vehicle-server's
 * ./http provider over the same Bearer-authenticated loopback transport
 * every Vehicle server uses -- so a daemon-backed Pi extension can project
 * a remote Vehicle through @danypops/vehicle-client-pi exactly as it would
 * a LocalVehicleClient. Exported as this package's ./http subpath;
 * jiti-safe under Pi's extension loader.
 *
 * Preserves LocalVehicleClient's semantics over the wire: every
 * VehicleInvocationOptions field is sent in the request body; the deadline
 * is converted to a relative deadlineMs (this client and the provider may
 * have different clocks); cancellation aborts the underlying fetch AND
 * best-effort notifies the provider's /vehicle/cancel so the operation
 * itself stops, not just this client's wait on it; progress requires the
 * SSE path (a plain JSON response can only carry a final result), so
 * onProgress being set is what selects it; a VehicleError round-trips with
 * its original code/category/details rather than becoming a generic HTTP
 * error.
 */
import { randomUUID } from "node:crypto";
import type {
	JsonValue,
	VehicleClient,
	VehicleEventHandler,
	VehicleFailureCategory,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleRecovery,
	VehicleSubscription,
} from "@danypops/vehicle-core";
import { VehicleError, vehicleEventTopic } from "@danypops/vehicle-core";
import { connectPushChannel } from "./daemon-client.js";

const KNOWN_FAILURE_CATEGORIES: readonly VehicleFailureCategory[] = [
	"validation",
	"not_found",
	"conflict",
	"authorization",
	"capacity",
	"timeout",
	"cancelled",
	"unavailable",
	"internal",
];

function parseFailureCategory(value: unknown): VehicleFailureCategory {
	return typeof value === "string" && (KNOWN_FAILURE_CATEGORIES as readonly string[]).includes(value)
		? (value as VehicleFailureCategory)
		: "internal";
}

export interface RemoteVehicleClientOptions {
	/** e.g. "http://127.0.0.1:4242" -- no trailing slash. */
	baseUrl: string;
	token: string;
	/** Defaults to the global fetch. Injectable for tests. */
	fetch?: typeof globalThis.fetch;
	/**
	 * Caches manifest() for this many milliseconds instead of hitting
	 * /vehicle/manifest on every call. Default (undefined) is today's exact
	 * behavior -- always fetch fresh, zero caching. The cache is a single
	 * slot (one manifest per client, not keyed) and is invalidated
	 * automatically the moment any non-"read"-effect invoke() through this
	 * same client succeeds, since that's the only way this client's own
	 * actions could have changed what the daemon now reports as available.
	 */
	manifestCacheTtlMs?: number;
	/**
	 * WebSocket URL for the push-invalidation channel this Vehicle's events
	 * are bridged onto (see push-channel.ts / bridgeVehicleEventsToPushChannel
	 * in vehicle-server). Only resolved the first time subscribe() is
	 * actually called -- a client that never subscribes pays zero cost.
	 * Defaults to baseUrl with http(s) swapped for ws(s) and "/push"
	 * appended, matching startDaemon()'s own default pushPath.
	 */
	pushUrl?: string;
	/** Defaults to the global WebSocket. Injectable for tests, passed straight through to connectPushChannel(). */
	WebSocketImpl?: typeof WebSocket;
}

function defaultPushUrl(baseUrl: string): string {
	return `${baseUrl.replace(/^http/, "ws")}/push`;
}

interface FailurePayload {
	code?: unknown;
	category?: unknown;
	message?: unknown;
	retryable?: unknown;
	retryAfterMs?: unknown;
	recovery?: unknown;
	details?: unknown;
	operationId?: unknown;
}

export class RemoteVehicleClient implements VehicleClient {
	private readonly fetchImpl: typeof globalThis.fetch;
	private closed = false;
	private cachedManifest: { manifest: VehicleManifest; expiresAt: number } | undefined;

	constructor(private readonly options: RemoteVehicleClientOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	async manifest(): Promise<VehicleManifest> {
		this.ensureOpen();
		if (this.cachedManifest && Date.now() < this.cachedManifest.expiresAt) return this.cachedManifest.manifest;

		const response = await this.fetchImpl(`${this.options.baseUrl}/vehicle/manifest`, {
			headers: { authorization: `Bearer ${this.options.token}` },
		});
		if (!response.ok) throw await this.errorFromResponse(response);
		const manifest = (await response.json()) as VehicleManifest;

		if (this.options.manifestCacheTtlMs !== undefined) {
			this.cachedManifest = { manifest, expiresAt: Date.now() + this.options.manifestCacheTtlMs };
		}
		return manifest;
	}

	async invoke<Output = unknown>(name: string, version: number, input: unknown, options: VehicleInvocationOptions = {}): Promise<Output> {
		this.ensureOpen();
		const operationId = options.operationId ?? randomUUID();
		const body = {
			name,
			version,
			input,
			operationId,
			correlationId: options.correlationId,
			deadlineMs: options.deadline !== undefined ? Math.max(0, options.deadline - Date.now()) : undefined,
			permissions: options.permissions,
			principal: options.principal,
			idempotencyKey: options.idempotencyKey,
			expectedRevision: options.expectedRevision,
			approvalCapability: options.approvalCapability,
		};

		const onAbort = options.signal ? (): void => void this.cancel(operationId) : undefined;
		if (onAbort) options.signal!.addEventListener("abort", onAbort, { once: true });
		try {
			const output = options.onProgress
				? await this.invokeStreaming<Output>(body, options)
				: await this.invokePlain<Output>(body, options.signal);
			this.invalidateManifestCacheIfWrite(name, version);
			return output;
		} finally {
			if (onAbort) options.signal!.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * A cached manifest only ever reflects what /vehicle/manifest reported at
	 * fetch time; a successful non-"read" invoke() through this same client
	 * is the one signal this client has that availability might now differ.
	 * Looked up against the cached manifest itself (never a fresh fetch) --
	 * an operation this client has never seen via manifest() can't be judged
	 * write-or-not, so it's left alone rather than guessed at.
	 */
	private invalidateManifestCacheIfWrite(name: string, version: number): void {
		if (!this.cachedManifest) return;
		const descriptor = this.cachedManifest.manifest.operations.find((op) => op.name === name && op.version === version);
		if (descriptor && descriptor.effect !== "read") this.cachedManifest = undefined;
	}

	/**
	 * Subscribes to one declared Vehicle event over the daemon's push channel,
	 * with the same reconnect/backoff/jitter/heartbeat resilience every other
	 * connectPushChannel() consumer gets -- not a new hand-rolled WebSocket.
	 * Each call opens its own connection (one per subscription, not shared/
	 * pooled) so close() on the returned VehicleSubscription is unambiguous.
	 */
	subscribe<Payload = unknown>(name: string, version: number, handler: VehicleEventHandler<Payload>): VehicleSubscription {
		this.ensureOpen();
		const topic = vehicleEventTopic(name, version);
		const client = connectPushChannel({
			url: this.options.pushUrl ?? defaultPushUrl(this.options.baseUrl),
			token: this.options.token,
			topics: [topic],
			onMessage: (receivedTopic, payload) => {
				if (receivedTopic === topic) handler(payload as Payload);
			},
			WebSocketImpl: this.options.WebSocketImpl,
		});
		return { close: () => client.close() };
	}

	/** Best-effort: notifies the provider to abort a still-in-flight operation. The local fetch's own AbortSignal already stops this client's wait regardless of whether this succeeds. */
	async cancel(operationId: string): Promise<void> {
		try {
			await this.fetchImpl(`${this.options.baseUrl}/vehicle/cancel`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
				body: JSON.stringify({ operationId }),
			});
		} catch {
			// Best-effort only.
		}
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}

	private async invokePlain<Output>(body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Output> {
		const response = await this.fetchImpl(`${this.options.baseUrl}/vehicle/invoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		const payload = (await response.json()) as { output?: Output; error?: FailurePayload };
		if (!response.ok) throw this.errorFromPayload(payload);
		return payload.output as Output;
	}

	private async invokeStreaming<Output>(body: Record<string, unknown>, options: VehicleInvocationOptions): Promise<Output> {
		const response = await this.fetchImpl(`${this.options.baseUrl}/vehicle/invoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify(body),
			signal: options.signal,
		});
		if (!response.ok || !response.body) throw await this.errorFromResponse(response);

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let frameEnd = buffer.indexOf("\n\n");
			while (frameEnd !== -1) {
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);
				const parsed = parseSseFrame(frame);
				if (parsed) {
					const outcome = this.handleSseFrame<Output>(parsed, options);
					if (outcome) return outcome.value;
				}
				frameEnd = buffer.indexOf("\n\n");
			}
		}
		throw new Error("Vehicle HTTP invoke stream ended without a result or error frame");
	}

	private handleSseFrame<Output>(frame: { event: string; data: string }, options: VehicleInvocationOptions): { value: Output } | undefined {
		if (frame.event === "progress") {
			options.onProgress?.(JSON.parse(frame.data));
			return undefined;
		}
		if (frame.event === "result") {
			return { value: (JSON.parse(frame.data) as { output: Output }).output };
		}
		if (frame.event === "error") {
			throw this.errorFromPayload({ error: JSON.parse(frame.data) as FailurePayload });
		}
		return undefined;
	}

	private ensureOpen(): void {
		if (this.closed) throw new Error("Vehicle HTTP client is closed");
	}

	private errorFromPayload(payload: { error?: FailurePayload } | undefined): Error {
		const failure = payload?.error;
		if (failure && typeof failure.code === "string" && typeof failure.message === "string") {
			const recovery =
				failure.recovery &&
				typeof failure.recovery === "object" &&
				"message" in failure.recovery &&
				typeof (failure.recovery as VehicleRecovery).message === "string"
					? (failure.recovery as VehicleRecovery)
					: undefined;
			return new VehicleError(failure.code, failure.message, {
				category: parseFailureCategory(failure.category),
				retryable: failure.retryable === true,
				retryAfterMs: typeof failure.retryAfterMs === "number" ? failure.retryAfterMs : undefined,
				recovery,
				details: failure.details as JsonValue | undefined,
				operationId: typeof failure.operationId === "string" ? failure.operationId : undefined,
			});
		}
		return new Error("Vehicle HTTP invoke failed");
	}

	private async errorFromResponse(response: Response): Promise<Error> {
		const payload = (await response.json().catch(() => undefined)) as { error?: FailurePayload } | undefined;
		return payload ? this.errorFromPayload(payload) : new Error(`Vehicle HTTP request failed with status ${response.status}`);
	}
}

function parseSseFrame(frame: string): { event: string; data: string } | undefined {
	let event: string | undefined;
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) event = line.slice("event:".length).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
	}
	return event ? { event, data: dataLines.join("\n") } : undefined;
}
