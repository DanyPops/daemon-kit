/**
 * "Trigger something at a future time or on a recurring interval,"
 * independent of any specific job's own lifecycle -- a distinct shape from
 * Vehicle Jobs (submit-then-track a unit of work already running). Modeled
 * on ~/Workspace/alef's packages/core/foundry/src/scheduler.ts
 * (defer/repeat/cancel/list), generalized so the fired action is a
 * declarative Vehicle operation invocation or event emission -- never a
 * bespoke callback closure, so it can be persisted and re-armed after a
 * restart the way a closure never could.
 *
 * Pure pieces only: trigger/action shapes and the fire-time arithmetic.
 * Real timers, persistence, and registry wiring live in vehicle-server's
 * VehicleScheduler, the same core/server split vehicle-jobs.ts uses.
 */
import type { JsonValue } from "./vehicle-contract.js";

export type VehicleScheduleTrigger = { readonly kind: "at"; readonly at: number } | { readonly kind: "every"; readonly intervalMs: number };

export type VehicleScheduleAction =
	| {
			readonly kind: "operation";
			readonly name: string;
			readonly version: number;
			readonly input: JsonValue;
			readonly permissions?: readonly string[];
	  }
	| { readonly kind: "event"; readonly name: string; readonly version: number; readonly payload: JsonValue };

export interface VehicleScheduledEntry {
	readonly scheduleId: string;
	readonly owner: string;
	readonly trigger: VehicleScheduleTrigger;
	readonly action: VehicleScheduleAction;
	readonly createdAt: number;
	/** For "at": consumed once it fires. For "every": advanced to the next tick after each fire. */
	readonly nextFireAt: number;
}

/** Matches WatchRegistry's own historical default (Lector's MAX_WATCHES_PER_WORKSPACE). */
export const DEFAULT_MAX_SCHEDULES_PER_OWNER = 32;

/** Raised when an owner already has its configured maximum of schedules -- fails closed, the same bounded-resource discipline WatchLimitExceeded already applies to Vehicle Watchers. */
export class VehicleScheduleLimitExceeded extends Error {
	constructor(
		readonly owner: string,
		readonly max: number,
	) {
		super(`owner "${owner}" already has ${max} active schedules -- cancel one before adding another`);
		this.name = "VehicleScheduleLimitExceeded";
	}
}

/** The first fire time for a freshly created schedule. */
export function initialFireAt(trigger: VehicleScheduleTrigger, now: number): number {
	return trigger.kind === "at" ? trigger.at : now + trigger.intervalMs;
}

/** The next fire time after a successful fire, or undefined if the entry (a one-shot "at") should be removed instead of re-armed. */
export function nextFireAtAfterFire(trigger: VehicleScheduleTrigger, now: number): number | undefined {
	return trigger.kind === "every" ? now + trigger.intervalMs : undefined;
}

/**
 * Where a restored entry should be re-armed to. A one-shot "at" entry keeps
 * its original persisted time (fires as soon as possible if overdue -- the
 * one thing it was supposed to do must not be silently lost). A recurring
 * "every" entry resumes its normal cadence from now if it fell behind while
 * the daemon was down, rather than firing once per missed tick.
 */
export function nextFireAtAfterRestore(trigger: VehicleScheduleTrigger, persistedNextFireAt: number, now: number): number {
	if (trigger.kind === "at") return persistedNextFireAt;
	return persistedNextFireAt > now ? persistedNextFireAt : now + trigger.intervalMs;
}
