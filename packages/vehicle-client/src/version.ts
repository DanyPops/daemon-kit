/**
 * Runtime package version read from the caller's own package.json — the
 * single release source of truth, never hand-duplicated or hardcoded.
 * Every @danypops daemon (jittor, lector, papyrus, pipes, tickets,
 * web-spider-daemon) already imports this from @danypops/vehicle-server's
 * own version.ts rather than duplicating it; this package now does the same.
 * (Previously hand-duplicated here on the premise that a client-side
 * consumer had no other reason to need vehicle-server -- no longer true:
 * vehicle-local-client.ts already imports VehicleRegistry's type from
 * @danypops/vehicle-server, and this package already lists it as a real
 * dependency.)
 */
export { createLiveVersionExpectation, readPackageVersion } from "@danypops/vehicle-server/version";
