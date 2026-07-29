/**
 * Daemon-side WebSocket push-invalidation channel -- lets a daemon proactively
 * tell every connected client the moment a mutation happens, instead of every
 * client polling on a fixed interval to find out. Additive to the existing
 * Bearer-authenticated fetch-based RPC (http.ts), not a replacement for it:
 * wire it into startDaemon() via the optional `pushChannel` option.
 *
 * Query-string token, not an Authorization header: the WHATWG WebSocket
 * constructor has no way to set arbitrary request headers (true in browsers
 * and in Node/Bun's global WebSocket alike), so `GET /push?token=...` is the
 * only broadly-portable way to authenticate the upgrade request itself.
 * Loopback-only, consistent with this kit's existing threat model.
 *
 * Bounded by design (see the resource-bounds standard this house holds
 * every daemon operation to): maxConnections caps total subscribers,
 * maxTopicsPerConnection caps how many topics one connection can subscribe
 * to -- a misbehaving or malicious client cannot make this channel an
 * unbounded memory sink.
 */
import { errorResponse } from "./http.ts";

export interface PushChannelOptions {
	token: string;
	/** Defaults to 64. */
	maxConnections?: number;
	/** Defaults to 32. */
	maxTopicsPerConnection?: number;
}

interface SubscriberData {
	topics: Set<string>;
}

type PushSocket = { data: SubscriberData; send(data: string): void; close(code?: number, reason?: string): void };

interface ServerLike {
	upgrade(request: Request, options?: { data: SubscriberData }): boolean;
}

export interface PushChannelWebSocketHandlers {
	open(ws: PushSocket): void;
	message(ws: PushSocket, message: string | Buffer): void;
	close(ws: PushSocket): void;
}

/** Client -> server control messages. */
type ClientMessage = { op: "subscribe" | "unsubscribe"; topic: string } | { op: "ping" };

export class PushChannel {
	private readonly token: string;
	private readonly maxConnections: number;
	private readonly maxTopicsPerConnection: number;
	private readonly subscribers = new Set<PushSocket>();
	private readonly byTopic = new Map<string, Set<PushSocket>>();

	constructor(options: PushChannelOptions) {
		this.token = options.token;
		this.maxConnections = options.maxConnections ?? 64;
		this.maxTopicsPerConnection = options.maxTopicsPerConnection ?? 32;
	}

	get connectionCount(): number {
		return this.subscribers.size;
	}

	/**
	 * Call from a daemon's fetch handler when the request path matches your
	 * push endpoint (e.g. "/push"). Returns null when the upgrade succeeded
	 * (Bun's own convention: don't return a Response after a successful
	 * server.upgrade()) -- return the Response otherwise.
	 */
	upgrade(request: Request, server: ServerLike): Response | null {
		const url = new URL(request.url);
		if (url.searchParams.get("token") !== this.token) return errorResponse("unauthorized", 401);
		if (this.subscribers.size >= this.maxConnections) return errorResponse("too many push connections", 503);
		const upgraded = server.upgrade(request, { data: { topics: new Set<string>() } });
		return upgraded ? null : errorResponse("upgrade failed", 400);
	}

	/** Bun.serve's `websocket` handler object -- pass directly as `Bun.serve({ ..., websocket: pushChannel.websocketHandlers() })`. */
	websocketHandlers(): PushChannelWebSocketHandlers {
		return {
			open: (ws) => {
				this.subscribers.add(ws);
			},
			message: (ws, raw) => {
				let parsed: ClientMessage;
				try {
					parsed = JSON.parse(String(raw)) as ClientMessage;
				} catch {
					return;
				}
				if (parsed.op === "ping") {
					ws.send(JSON.stringify({ op: "pong" }));
					return;
				}
				if (parsed.op === "subscribe") {
					if (ws.data.topics.size >= this.maxTopicsPerConnection) return;
					ws.data.topics.add(parsed.topic);
					this.indexTopic(parsed.topic, ws);
				} else if (parsed.op === "unsubscribe") {
					ws.data.topics.delete(parsed.topic);
					this.byTopic.get(parsed.topic)?.delete(ws);
				}
			},
			close: (ws) => {
				this.subscribers.delete(ws);
				for (const topic of ws.data.topics) this.byTopic.get(topic)?.delete(ws);
			},
		};
	}

	/** Broadcasts `payload` to every connection currently subscribed to `topic`. A no-op if nobody is subscribed. */
	publish(topic: string, payload: unknown): void {
		const targets = this.byTopic.get(topic);
		if (!targets?.size) return;
		const frame = JSON.stringify({ topic, payload });
		for (const ws of targets) ws.send(frame);
	}

	private indexTopic(topic: string, ws: PushSocket): void {
		let set = this.byTopic.get(topic);
		if (!set) {
			set = new Set();
			this.byTopic.set(topic, set);
		}
		set.add(ws);
	}
}
