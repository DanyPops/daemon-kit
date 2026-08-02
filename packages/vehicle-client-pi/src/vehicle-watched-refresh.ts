/**
 * Generalizes the "lazily connect a push channel, fall back to polling,
 * retry once the daemon comes up" dance every Vehicle-backed Pi widget with
 * live-refresh has so far hand-rolled independently -- confirmed twice
 * within Papyrus alone (TaskOverlay, NoteOverlay each pair their own
 * ensurePushChannel() + BoundedPoll), on top of Lector's own two more
 * reinventions of the same "watch a changing resource" shape (see the
 * research this task is drawn from). A widget author now supplies three
 * things -- how to call the daemon's own watch(resource) operation, how to
 * resolve the current push-channel target, and what "refresh" means for
 * this widget -- and gets lazy connect, poll fallback, and connectPushChannel()'s
 * own reconnect/backoff/jitter/heartbeat resilience for free.
 *
 * Deliberately re-attempts watch() on every poll tick while disconnected,
 * mirroring subscribeTaskPushChannel's own tolerance for "the daemon hasn't
 * started yet" -- a widget's very first refresh may run before any daemon
 * handle exists on disk, and this is the natural, already-scheduled retry
 * point rather than a second timer.
 */
import { connectPushChannel, type PushChannelClient } from "@danypops/vehicle-client/daemon-client";

export interface VehicleWatchTarget {
	readonly watchId: string;
	readonly topic: string;
}

export interface VehiclePushTarget {
	readonly url: string;
	readonly token: string;
}

export interface WatchedRefreshOptions {
	/**
	 * Calls the daemon's own "${name}.watch" operation and returns its
	 * {watchId, topic} output. Return undefined when the daemon isn't
	 * reachable yet (mirrors subscribeTaskPushChannel's own tolerance) --
	 * the next poll tick retries automatically.
	 */
	watch: () => Promise<VehicleWatchTarget | undefined>;
	/**
	 * Resolves the push channel's current {url, token} -- re-invoked on
	 * every reconnect attempt (a daemon rebinds a new random port on every
	 * restart). Returning undefined behaves like watch() returning
	 * undefined: push connection stays down, polling keeps this widget
	 * refreshed regardless.
	 */
	resolvePushTarget: () => VehiclePushTarget | undefined;
	/** Does the real refresh (e.g. re-fetch and re-render). Called on every push notification for this watch's own topic, and on every poll tick regardless of push state. Thrown/rejected errors are the caller's own concern -- not swallowed here, unlike registerVehicleStatusRefresh's status-bar use case, since a widget's own refresh() already has its own established error handling (e.g. TaskOverlay's try/catch around callService). */
	refresh: () => void | Promise<void>;
	pollIntervalMs: number;
	/** Defaults to the global WebSocket. Injectable for tests. */
	WebSocketImpl?: typeof WebSocket;
}

export interface WatchedRefreshHandle {
	/** Stops polling and closes any open push connection. Idempotent. */
	stop(): void;
}

/**
 * Starts polling immediately (does not wait for the first tick) and
 * attempts to establish the push connection in the background -- a widget
 * gets an immediate refresh without waiting on a network round trip first.
 */
export function startWatchedRefresh(options: WatchedRefreshOptions): WatchedRefreshHandle {
	let pushChannel: PushChannelClient | undefined;
	let connecting = false;
	let stopped = false;

	function ensurePushChannel(): void {
		if (stopped || connecting) return;
		if (pushChannel && pushChannel.state() !== "closed") return;
		connecting = true;
		void options
			.watch()
			.then((target) => {
				if (stopped || !target) return;
				const initialPushTarget = options.resolvePushTarget();
				if (!initialPushTarget) return;
				pushChannel = connectPushChannel({
					url: () => {
						const resolved = options.resolvePushTarget();
						if (!resolved) throw new Error("Vehicle push target is not currently resolvable");
						return resolved.url;
					},
					token: initialPushTarget.token,
					topics: [target.topic],
					onMessage: (topic) => {
						if (topic === target.topic) void options.refresh();
					},
					WebSocketImpl: options.WebSocketImpl,
				});
			})
			.catch(() => {
				// watch() or the push connection setup failed (daemon unreachable,
				// etc.) -- the next poll tick retries; polling alone keeps this
				// widget refreshed in the meantime.
			})
			.finally(() => {
				connecting = false;
			});
	}

	void options.refresh();
	ensurePushChannel();
	const timer = setInterval(() => {
		void options.refresh();
		ensurePushChannel();
	}, options.pollIntervalMs);

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			pushChannel?.close();
			pushChannel = undefined;
		},
	};
}
