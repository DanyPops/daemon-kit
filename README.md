# @danypops/daemon-kit

Shared daemon substrate and runtime-neutral Vehicle SDK for agent tools.

## Why this exists

Four independent daemons (`web-spider-daemon`, `jittor`, `papyrus`, `pi-packed`)
each hand-rolled the same problem: an XDG-path-resolved, Bearer-token-authenticated,
loopback-only Bun service backed by SQLite, with a typed RPC client on the other
end. Two of the four originals' own header comments admitted the duplication
("mirrors jittor/src/state.ts exactly"). This package is that shared substrate,
factored out after the fact, once four real implementations existed to compare.

## Modules

Each module is independently importable (`@danypops/daemon-kit/paths`, etc.) so
a consumer only pulls in what it uses.

| Module | Replaces | Responsibility |
|---|---|---|
| `paths` | each daemon's `state.ts` | Cross-platform path resolution (Linux: XDG; macOS: ~/Library/Application Support etc.; Windows: %LOCALAPPDATA%/%APPDATA%), cross-checked in tests against `env-paths` without taking it as a runtime dependency. Single-instance lock (`acquireDaemonLock`/`releaseDaemonLock`, atomic wx-create with dead-pid theft) so exactly one daemon process ever binds. Auth token load-or-create, atomic daemon handle write/read/remove. Loopback-only is a hard invariant here, not a per-daemon option. |
| `storage` | each daemon's `db.ts` | bun:sqlite bootstrap: `foreign_keys`, `busy_timeout`, `journal_mode=WAL`, `optimize`, and a `PRAGMA user_version` migration runner. The version-gap/downgrade-checking migration engine (`runMigrations`) is generic over a small `SqliteMigrationRunner<Handle>` port, so a storage layer that isn't bun:sqlite-shaped (e.g. node:sqlite, or a project's own dual-runtime `Db` abstraction) can reuse it via its own adapter, without editing this module. |
| `logging` | each daemon's `log.ts` (or lack of one) | Structured, credential-safe logging backed by pino, preserving the pre-existing string-level JSON shape so existing log consumers keep working. |
| `http` | each daemon's `service.ts` auth/health scaffolding | Bearer-token check, JSON/error/health/ready response helpers. Deliberately not a routing framework -- each daemon has a handful of routes, too few to justify one. |
| `session-identity` | ad hoc, unverified session-id fields (new) | First-touch capability binding for daemon operations where a caller-supplied session id becomes behavior-affecting, not just an audit label -- a shared bearer token cannot distinguish which client is calling, so a session id alone is not a credential. Storage-agnostic: owns the crypto primitive and a store interface, not a schema. |
| `daemon` | each daemon's `daemon.ts` | Composition root: acquire the single-instance lock before binding anything (a losing concurrent start throws `DaemonAlreadyRunningError` and never binds a port -- runDaemonProcess() treats that as a normal join, exit 0, not a crash), bind loopback:0, write the handle only after a successful bind, run periodic maintenance tasks (failures logged, never silently swallowed, never crash the daemon), idle-timeout self-shutdown, clean SIGINT/SIGTERM. **Behavior change:** idle shutdown is no longer opt-in-only -- an explicit `idleBudgetMs` always wins, but when omitted the default is now derived from `DAEMON_KIT_LAUNCH_PROVENANCE` (set by `spawnDetachedDaemon()` to `"auto-spawn"`, or by a generated service unit/plist to `"service"`): a service-installed daemon defaults to always-on (unchanged from before), while an auto-spawned or provenance-unknown one now gets a bounded 30-minute idle budget instead of running forever by default. `startDaemon()` is process-signal-free and testable in-process; `runDaemonProcess()` adds the real binary's signal wiring. |
| `service` | web-spider-daemon's bespoke systemd --user unit writer, and nonexistent everywhere else | Cross-platform login/boot persistence: `installUserService()`/`uninstallUserService()`/`isServiceInstalled()` generate and register a systemd --user unit (Linux, init-system-detected by binary presence, not assumed), a launchd user agent plist (macOS), or an HKCU Run registry value via `reg.exe` (Windows, no elevation, no native dependency). Deliberately not a process supervisor -- no `Restart=`/`KeepAlive` -- since connectWithPolicy's auto-spawn plus the single-instance lock already resurrect the daemon lazily on next use regardless of platform; this module's only job is getting one started once after login. |
| `rpc-client` | each daemon's `client.ts` | Typed `AuthenticatedRpcClient<Op, Inputs, Outputs>`: `call(op, input)`, `operations()`, `health()`, `ready()` over a single Bearer-authenticated dispatch endpoint. |
| `version` | each daemon's `version.ts` | Reads the running version from the caller's own `package.json` -- the single release source of truth, never hand-duplicated or hardcoded. |
| `pi-load-harness` | ad hoc, per-consumer jiti test setups (new) | Verifies a module loads under every path Pi's own extension loader can take (native ESM, jiti tryNative:false, jiti tryNative:true), so a Pi-facing module or its test suite can assert load-safety directly instead of discovering a loader failure in a live session. |
| `pi-client` | each Pi extension's own retrying-client copy (lector's `lectorClient()`, web-spider's `callWebSpider()`, papyrus's `callService()`, pi-packed's `createNatives()`) and their independently-forked auto-start policy | `createRetryingClient()`: caches a connected client and retries exactly once against a freshly reconnected one on a stale-connection error (the daemon rebinds a random port on every restart), and fails fast via a circuit breaker after sustained connect failures instead of paying a full connect timeout on every call. `connectWithPolicy()`: one explicit `autoStart` flag (default false, fail closed) instead of a silent per-daemon fork between failing closed and transparently spawning the daemon. `connectWithVersionCheck()`: detects a daemon left running from before an extension upgrade and transparently replaces it. `spawnDetachedDaemon()`: platform-correct spawn options (Windows console-hiding) for the four independent `spawn()` callbacks. Shipped pre-compiled via `bun run build:pi-client`. |
| `vehicle` | agent hosts' and tool providers' local command runtimes | Runtime-neutral operation descriptors and schema codecs, executable bindings, unique provider ownership, `LocalVehicleClient`, `RemoteVehicleClient` (authenticated HTTP, same semantics as local), structured failures, permissions, idempotency requirements, execution policy, deadlines, cancellation, progress, and request/response bounds. The serializable descriptor stays separate from executable code. Shipped pre-compiled via `bun run build:vehicle`. |
| `vehicle-http-provider` | daemon-side hand-rolled Vehicle HTTP routes (new) | `createVehicleHttpApp()` exposes a `VehicleRegistry` over `GET /vehicle/manifest`, `POST /vehicle/invoke` (JSON by default, Server-Sent Events when `Accept: text/event-stream` -- needed for progress), and `POST /vehicle/cancel`. Bearer-authenticated via `http.ts`. Daemon-side raw TypeScript, pairs with `vehicle`'s `RemoteVehicleClient` on the other end. |
| `vehicle-conformance` | ad hoc, independently hand-written per-implementation Vehicle tests that could silently drift apart (new) | `runVehicleClientConformance()` runs one shared assertion suite -- manifest accuracy, input validation, permissions, real handler failures, keyed idempotency, byte bounds, not-found, progress-before-result ordering, cancellation, deadlines, close() -- against any `VehicleClient` a fixture supplies. Caught a real bug live: `LocalVehicleClient.manifest()` threw synchronously instead of rejecting after `close()`, unlike its own `invoke()` and `RemoteVehicleClient.manifest()` -- exactly the kind of drift a shared suite catches and two separate test files wouldn't. |
| `vehicle-pi` | hand-written `pi.registerTool()` wrappers around service clients | Projects a `VehicleClient` manifest into native Pi tools. It preserves exact operation versions, schemas, cancellation, Pi call/session identity, explicit permissions and principals, keyed idempotency, progress, and structured failures. Destructive and open-world operations require a real approval capability. Shipped pre-compiled via `bun run build:vehicle-pi`. |

## Use a Vehicle from a Pi extension

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVehicleTools } from "@danypops/daemon-kit/vehicle-pi";
import { createIssuesVehicleClient } from "./issues-client.js";

export default async function (pi: ExtensionAPI) {
  const client = createIssuesVehicleClient();
  await registerVehicleTools(pi, client, {
    permissions: ["issues:read"],
    principal: { id: "pi-extension" },
    closeClientOnSessionShutdown: true,
  });
}
```

The extension factory must be async because it reads the Vehicle manifest before
Pi starts the session. Operation names are projected to Pi-safe names (`issues.search`
becomes `issues_search`); multiple versions receive `_vN` suffixes. Existing or
projected name collisions fail before any tool is registered. Supply
`resolveInvocation` when an operation needs per-call revisions, delegated
permissions, or an approval capability minted by an authority.

## What this deliberately does not include

- A routing framework (Hono, itty-router, tRPC): the auth/health/ops routing
  each daemon needs is a handful of `if` branches; a framework would add more
  surface than it removes.
- A replacement for the SQLite migration runner's shape: `PRAGMA user_version`
  is small, already proven across three of the four daemons, and has no known
  bug class a heavier tool (kysely, umzug) would fix.

## Status

The daemon walking skeleton in `test/walking-skeleton.test.ts` covers bind,
auth, migration, dispatch, maintenance, and shutdown. `test/vehicle.test.ts`
covers the runtime-neutral local Vehicle path; `test/vehicle-pi.test.ts` covers
its Pi-native tool projection.
