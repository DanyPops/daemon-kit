/**
 * A per-inbound-RPC-call correlation id -- one id, generated once per
 * request at the single dispatch point each transport already funnels
 * every call through (serveUnixRpc's own data() handler; startDaemon's
 * Bun/Node listeners' own app.fetch() call), available to every
 * `logger.*` call made anywhere during that call's execution however many
 * `await`s deep, without threading it through every function signature in
 * between. Bound via Node's built-in AsyncLocalStorage, read back by
 * logging.ts's own pino `mixin` so every log line emitted during the call
 * carries it automatically.
 *
 * Deliberately a correlation id, not distributed tracing: these are
 * single-hop, loopback-only daemons (a Unix socket or local HTTP, one
 * process serving one caller at a time per call), not a network of
 * services propagating trace context across hops -- the OTel ROI case
 * (cross-service trace propagation) doesn't apply here, and building
 * spans/traces for it would be unwarranted scope.
 *
 * Field name `rpcCallId` -- deliberately NOT reusing `correlationId` or
 * `operationId`, both of which already name a different, real concept in
 * this codebase: VehicleInvocationOptions.correlationId is a caller-supplied
 * (or session-derived) id spanning potentially many invoke() calls across a
 * whole Pi session; VehicleInvocationOptions.operationId identifies one
 * Vehicle operation invocation specifically, for cancellation tracking.
 * `rpcCallId` is neither -- it identifies one raw inbound request at the
 * transport layer, generated fresh here regardless of whether that request
 * turns out to be a Vehicle invoke() at all (e.g. a plain GET
 * /vehicle/manifest has no operationId/correlationId of its own, but still
 * gets an rpcCallId). Reusing an existing name for this different concept
 * is exactly the "same concept, different key name" class of bug in
 * reverse -- same key name, different concept -- this file exists to avoid.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const rpcCallIdStorage = new AsyncLocalStorage<string>();

/** Runs `fn` with `id` bound as the current rpcCallId for the duration of its whole async execution, however many `await`s deep. */
export function runWithRpcCallId<T>(id: string, fn: () => T): T {
	return rpcCallIdStorage.run(id, fn);
}

/** The current call's rpcCallId, or undefined outside any bound call (e.g. a maintenance timer, not an inbound RPC request). */
export function getCurrentRpcCallId(): string | undefined {
	return rpcCallIdStorage.getStore();
}
