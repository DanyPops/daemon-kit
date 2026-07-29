# daemon-kit workspace

Shared daemon substrate (`@danypops/daemon-kit`) and a runtime-neutral Vehicle
SDK for agent tools (`@danypops/vehicle-*`), as a Bun workspace of independently
versioned, independently publishable packages under `packages/*`.

## Why this exists

Four independent daemons (`web-spider-daemon`, `jittor`, `papyrus`, `pi-packed`)
each hand-rolled the same problem: an XDG-path-resolved, Bearer-token-authenticated,
loopback-only Bun service backed by SQLite, with a typed RPC client on the other
end. Two of the four originals' own header comments admitted the duplication
("mirrors jittor/src/state.ts exactly"). `@danypops/daemon-kit` is that shared
substrate, factored out after the fact, once four real implementations existed
to compare.

Vehicle grew out of `@danypops/daemon-kit` as a distinct concern -- a
runtime-neutral contract any agent host or tool provider can implement,
independent of daemon-kit's own HTTP/process/storage machinery -- and now lives
as its own family of packages rather than daemon-kit subpath exports. Each
Vehicle package is a real npm package with its own version and its own
`exports` map, not a barrel re-exporting unrelated concerns under one bundle:
a consumer that only needs `VehicleRegistry` never pulls in an HTTP client, a
Pi projection, or a session decorator it isn't using.

## Workspace layout

| Package | Depends on (workspace) | Role |
|---|---|---|
| `@danypops/daemon-kit` | -- | Process lifecycle, SQLite storage bootstrap, structured logging, HTTP auth/RPC, service installation, secrets. See its own module table below. |
| `@danypops/vehicle-core` | -- | Vehicle's wire contract: operation descriptors, schema codecs, failure shapes. Zero runtime dependencies, zero Bun-specific code. |
| `@danypops/vehicle-server` | `vehicle-core` | `VehicleRegistry` (execution engine) at `.`; its authenticated HTTP hosting surface at `./http`. |
| `@danypops/vehicle-client` | `vehicle-core`, `vehicle-server` | `LocalVehicleClient` at `./local`; `RemoteVehicleClient` at `./http`. No root export -- each is a real, independent way to reach a `VehicleClient`. |
| `@danypops/vehicle-client-pi` | `vehicle-core` | Projects any `VehicleClient` into native Pi tools, with live availability curation. |
| `@danypops/vehicle-conformance` | `vehicle-core`, `vehicle-server` | Host-neutral `bun:test` conformance suite any `VehicleClient` implementation must satisfy identically. Ships raw TypeScript -- a test-time devDependency, not a runtime library. |

**No Vehicle package depends on `@danypops/daemon-kit` at runtime.** Vehicle is
a runtime-neutral contract for any agent host or tool provider, not daemon-kit
infrastructure -- the two small pieces that used to create that coupling were
diffused out: `vehicle-server`'s `./http` keeps its own tiny (~15 line),
Fetch-API-only Bearer-auth/JSON-response helpers instead of importing
`daemon-kit/http`, and `pi-tool-availability` (Pi tool-visibility curation)
moved bodily into `vehicle-client-pi`, its one real consumer, instead of
living in daemon-kit and being imported back. `vehicle-client-pi` keeps
daemon-kit only as a devDependency, for its own load-safety test harness.

## `@danypops/daemon-kit` modules

Each module is independently importable (`@danypops/daemon-kit/paths`, etc.) so
a consumer only pulls in what it uses.

| Module | Replaces | Responsibility |
|---|---|---|
| `paths` | each daemon's `state.ts` | Cross-platform path resolution (Linux: XDG; macOS: ~/Library/Application Support etc.; Windows: %LOCALAPPDATA%/%APPDATA%), cross-checked in tests against `env-paths` without taking it as a runtime dependency. Single-instance lock (`acquireDaemonLock`/`releaseDaemonLock`, atomic wx-create with dead-pid theft) so exactly one daemon process ever binds. Auth token load-or-create, atomic daemon handle write/read/remove. Loopback-only is a hard invariant here, not a per-daemon option. |
| `storage` | each daemon's `db.ts` | bun:sqlite bootstrap: `foreign_keys`, `busy_timeout`, `journal_mode=WAL`, `optimize`, and a `PRAGMA user_version` migration runner. The version-gap/downgrade-checking migration engine (`runMigrations`) is generic over a small `SqliteMigrationRunner<Handle>` port, so a storage layer that isn't bun:sqlite-shaped (e.g. node:sqlite, or a project's own dual-runtime `Db` abstraction) can reuse it via its own adapter, without editing this module. |
| `logging` | each daemon's `log.ts` (or lack of one) | Structured, credential-safe logging backed by pino, preserving the pre-existing string-level JSON shape so existing log consumers keep working. |
| `http` | each daemon's `service.ts` auth/health scaffolding | Bearer-token check, JSON/error/health/ready response helpers. Deliberately not a routing framework -- each daemon has a handful of routes, too few to justify one. |
| `session-identity` | ad hoc, unverified session-id fields (new) | First-touch capability binding for daemon operations where a caller-supplied session id becomes behavior-affecting, not just an audit label -- a shared bearer token cannot distinguish which client is calling, so a session id alone is not a credential. Storage-agnostic: owns the crypto primitive and a store interface, not a schema. |
| `daemon` | each daemon's `daemon.ts` | Composition root: acquire the single-instance lock before binding anything (a losing concurrent start rejects with `DaemonAlreadyRunningError` and never binds a port -- runDaemonProcess() treats that as a normal join, exit 0, not a crash), bind loopback:0, write the handle only after a successful bind, run periodic maintenance tasks (failures logged, never silently swallowed, never crash the daemon), idle-timeout self-shutdown, clean SIGINT/SIGTERM. **Runtime-dual**: Bun (`Bun.serve`) or plain Node (`node:http`), runtime-detected the same way `storage.ts` already does for SQLite -- `buildApp()`'s `{ fetch(Request): Promise<Response> }` contract is already Web-standard, so nothing above that layer changes; verified against a real spawned `node` process, not just at the type level. `pushChannel` (see `push-channel`) requires Bun (WebSocket upgrade) -- passing one under Node rejects with an actionable error rather than silently degrading. **Behavior change:** `startDaemon()` is now always async (Node's `listen()` cannot bind synchronously the way `Bun.serve()` does) -- existing callers need `await`. Idle shutdown is also no longer opt-in-only -- an explicit `idleBudgetMs` always wins, but when omitted the default is now derived from `DAEMON_KIT_LAUNCH_PROVENANCE` (set by `spawnDetachedDaemon()` to `"auto-spawn"`, or by a generated service unit/plist to `"service"`): a service-installed daemon defaults to always-on, while an auto-spawned or provenance-unknown one gets a bounded 30-minute idle budget. `runDaemonProcess()` adds the real binary's signal wiring. Shipped pre-compiled (`./daemon` -> `dist/daemon.js`, bundled with `paths`/`http`/`logging`/`push-channel`) via `bun run build:daemon` -- Node refuses to type-strip *any* `.ts` file under `node_modules` (a permanent policy, confirmed directly against Node's own docs, not a missing flag), and a real consumer's own `tsc` build has no `Bun` global type available -- both real blockers for a plain-Node consumer of raw source, both closed by compiling instead. |
| `service` | web-spider-daemon's bespoke systemd --user unit writer, and nonexistent everywhere else | Cross-platform login/boot persistence: `installUserService()`/`uninstallUserService()`/`isServiceInstalled()` generate and register a systemd --user unit (Linux, init-system-detected by binary presence, not assumed), a launchd user agent plist (macOS), or an HKCU Run registry value via `reg.exe` (Windows, no elevation, no native dependency). Deliberately not a process supervisor -- no `Restart=`/`KeepAlive` -- since connectWithPolicy's auto-spawn plus the single-instance lock already resurrect the daemon lazily on next use regardless of platform; this module's only job is getting one started once after login. |
| `process-supervisor` | Enigma's own `src/supervisor.ts` (restart-policy interpretation, a credential-refresh restart, the shutdown contract) | `runProcessSupervisor()` builds on `supervisor.ts`'s minimal `spawnUnit()`: restart-policy interpretation (`always`/`on-failure`/`no`), a `shouldPlannedRestart` predicate checked on a timer that kills-and-relaunches bypassing restart policy entirely (for a reason other than a crash), an explicit `restartUnit(name)` escape hatch independent of that timer, and the shutdown contract (graceful shutdown -- see below -- to every unit, `stop()` resolves only once all have actually exited). `resolveEnv` is called fresh at every (re)launch, not once at supervisor start. Generic on purpose -- a caller's own secret resolution and freshness predicate are supplied as callbacks, never hardcoded here. |
| `supervisor` (graceful shutdown) | Enigma's own `process.on("SIGTERM", ...)` fixture/unit code, which silently doesn't work on Windows | `spawnUnit()`'s `requestGracefulShutdown()` sends a real SIGTERM on POSIX (unchanged), or -- on Windows, where `ChildProcess.kill("SIGTERM")` unconditionally terminates the process without ever invoking a handler -- writes a magic line to the unit's stdin instead (stdin is now piped, not ignored, specifically to make this possible). `awaitGracefulShutdown()` is the unit-side counterpart: a unit calls it once at startup to react identically to a real POSIX signal or the Windows stdin fallback, without needing its own platform branch. `platform` is injectable on `spawnUnit()` (mirroring `paths.ts`/`service.ts`'s own convention) so the Windows code path -- a real write to a real child's stdin, received and acted on for real -- is exercised in CI on any host OS; the one fact that can't be verified off a real Windows machine is that `kill("SIGTERM")` itself would have failed there. |
| `rpc-client` | each daemon's `client.ts` | Typed `AuthenticatedRpcClient<Op, Inputs, Outputs>`: `call(op, input)`, `operations()`, `health()`, `ready()` over a single Bearer-authenticated dispatch endpoint. |
| `version` | each daemon's `version.ts` | Reads the running version from the caller's own `package.json` -- the single release source of truth, never hand-duplicated or hardcoded. |
| `pi-load-harness` | ad hoc, per-consumer jiti test setups (new) | Verifies a module loads under every path Pi's own extension loader can take (native ESM, jiti tryNative:false, jiti tryNative:true), so a Pi-facing module or its test suite can assert load-safety directly instead of discovering a loader failure in a live session. |
| `pi-client` | each Pi extension's own retrying-client copy (lector's `lectorClient()`, web-spider's `callWebSpider()`, papyrus's `callService()`, pi-packed's `createNatives()`) and their independently-forked auto-start policy | `createRetryingClient()`: caches a connected client and retries exactly once against a freshly reconnected one on a stale-connection error (the daemon rebinds a random port on every restart), and fails fast via a circuit breaker after sustained connect failures instead of paying a full connect timeout on every call. `connectWithPolicy()`: one explicit `autoStart` flag (default false, fail closed) instead of a silent per-daemon fork between failing closed and transparently spawning the daemon. `connectWithVersionCheck()`: detects a daemon left running from before an extension upgrade and transparently replaces it. `spawnDetachedDaemon()`: platform-correct spawn options (Windows console-hiding) for the four independent `spawn()` callbacks. `connectPushChannel()`: subscribes to a daemon's push-invalidation channel (see `push-channel`) with real reconnection -- exponential backoff gated by a minimum-uptime window so a connection that opens then drops again immediately keeps backing off instead of resetting on every brief open (degradation, not just down/up), jittered to avoid a reconnect storm when several Pi sessions reconnect to the same restarted daemon at once, plus a heartbeat ping/timeout to catch a socket that stays open while the daemon itself is hung. Re-subscribes every topic after each reconnect. Uses only the global `WebSocket` (Node 22+/Bun). Shipped pre-compiled via `bun run build:pi-client`. |
| `push-channel` | nothing -- Papyrus's Task widget could previously only poll on a fixed interval (new) | `PushChannel` wires an optional authenticated WebSocket upgrade into `startDaemon()` (`GET /push?token=...`, query-string token since the WebSocket constructor cannot set an Authorization header) alongside the existing fetch-based RPC. `publish(topic, payload)` broadcasts to every subscriber of that topic the moment a mutation happens, instead of every client waiting out a poll interval. Bounded connection count and topics-per-connection. Pairs with `pi-client`'s `connectPushChannel()`. Shipped pre-compiled (`./push-channel` -> `dist/push-channel.js`, built together with `daemon` via `bun run build:daemon`) so a `PushChannel` built through this export shares one type identity with `startDaemon()`'s own `pushChannel` option. |
| `secrets-backend` | each consumer's own ad hoc credential-status listing (new) | `SecretsBackend` port: `list`/`get` (redacted `SecretRecord`s -- name, source, configured, expiry, scope, never the value), `rotate`/`revoke`, and `reveal(name): Promise<Record<string, unknown> \| undefined>` (the one deliberate exception -- the real, unredacted stored value). A backend that can't support rotate/revoke/reveal throws `SecretsBackendUnsupportedOperationError` rather than silently no-op'ing. Ships `createEnvSecretsBackend` (env vars: reveal returns the raw value; rotate/revoke always unsupported -- an env var isn't this process's to mutate) and `createLocalSecretsBackend` (a `vault.ts`-backed on-disk store: reveal returns the full stored token, plaintext or decrypted transparently to the caller; revoke deletes the file; rotate unsupported, no generic re-auth mechanism exists). An optional `ServicesRegistry` groups secrets under a higher-level concept a consumer already has ("jira" needing three backends configured) -- deliberately excludes registration/login logic, which stays in each consumer's own extension via `extraActions`. |
| `secrets-tui` / `secrets-registry` | separate ad hoc secrets menus per extension (`/secrets`, `/tickets-secrets`, a "Secrets" submenu inside `/pipes`) | One real shared Pi command (`registerSharedSecretsCommand`): every consumer contributes a `SecretsContribution` (backends + optional servicesRegistry + extraActions) to a process-wide, `globalThis`-keyed registry (`secrets-registry.ts` -- robust to different consumers resolving different nested copies of this package), and only the first caller actually calls `pi.registerCommand("secrets", ...)`; every invocation re-resolves and merges every registered contributor fresh. Per-secret actions: Rotate, Revoke, and Reveal. Reveal is refused outright when `ctx.mode !== "tui"` -- `/secrets` is one command definition shared across tui/rpc/print/json modes, and an RPC-driven (non-interactive) caller could otherwise walk the same picks a human would in TUI and get a raw value back mechanically; a real human at a real terminal is not restricted, the same as any backend's own CLI reveal path already allows. `registerSecretsCommand` remains available for a consumer that genuinely wants its own standalone, non-shared command. |

## Vehicle packages

`@danypops/vehicle-core` defines operation descriptors, schema codecs,
executable bindings, unique provider ownership, structured failures,
permissions, idempotency requirements, deadlines, cancellation, progress, and
request/response bounds. The serializable descriptor stays separate from
executable code. Zero runtime dependencies.

`@danypops/vehicle-server`'s root export is `VehicleRegistry`: registration,
permission/deadline/payload enforcement, an execution policy hook, and
`setAvailability(name, version, available, reason?)`, which toggles a
registered operation's usability at runtime (e.g. a credential got configured
or removed) -- there's no unregister, an operation's shape is permanent once
registered, only whether `manifest()` reports it `available` and whether
`invoke()` accepts it. Its `./http` export, `createVehicleHttpApp()`, exposes a
registry over `GET /vehicle/manifest`, `POST /vehicle/invoke` (JSON by default,
Server-Sent Events when `Accept: text/event-stream` -- needed for progress),
and `POST /vehicle/cancel`, Bearer-authenticated via `@danypops/daemon-kit/http`.
Kept as a separate subpath from the root export on purpose: a consumer that
only builds/tests a registry never pulls in HTTP request/response plumbing.

`@danypops/vehicle-client` has no root export -- `./local` (`LocalVehicleClient`,
a same-process client wrapping a `VehicleRegistry` directly) and `./http`
(`RemoteVehicleClient`, authenticated HTTP with the same semantics as local)
are each a real, independent way to reach a `VehicleClient`; importing one must
never pull the other in.

`@danypops/vehicle-client-pi` projects a `VehicleClient` manifest into native
Pi tools. It preserves exact operation versions, schemas, cancellation, Pi
call/session identity, explicit permissions and principals, keyed idempotency,
progress, and structured failures. Destructive and open-world operations
require a real approval capability. A currently-unavailable operation (per the
manifest's `available` flag) is still registered as a Pi tool -- Pi has no
`unregisterTool()` -- but curated out of the LLM's active/callable set from the
very first `registerVehicleTools()` call via its own `syncManagedActiveTools`
primitive (Vehicle-agnostic, exported separately for any Pi extension
curating its own tool visibility, not just this one).
`refreshVehicleToolAvailability()` re-fetches the manifest on whatever
cadence the caller chooses (a maintenance-task interval, a push notification,
a session_start recheck) and re-syncs active/inactive state for known tools,
registering any genuinely new operation for the first time.

`@danypops/vehicle-conformance`'s `runVehicleClientConformance()` runs one
shared assertion suite -- manifest accuracy, input validation, permissions,
real handler failures, keyed idempotency, byte bounds, not-found,
progress-before-result ordering, cancellation, deadlines, close() -- against
any `VehicleClient` a fixture supplies. Caught a real bug live:
`LocalVehicleClient.manifest()` threw synchronously instead of rejecting after
`close()`, unlike its own `invoke()` and `RemoteVehicleClient.manifest()` --
exactly the kind of drift a shared suite catches and two separate test files
wouldn't.

## Use a Vehicle from a Pi extension

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVehicleTools } from "@danypops/vehicle-client-pi";
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

An operation the provider currently can't service (e.g. `jira_search` before
any Jira credential is configured) is still registered, so it can be revealed
later without Pi's missing `unregisterTool()` getting in the way, but it starts
*inactive* -- invisible to the LLM's tool-calling surface from turn one, not a
call that fails. Reflect a later change (a credential got configured or
removed) with `refreshVehicleToolAvailability()`. The underlying primitive,
`syncManagedActiveTools(pi, managedToolNames, desiredActiveToolNames)`, lives
in `@danypops/vehicle-client-pi` itself: Pi's `setActiveTools()` replaces the
*whole* active set, so a naive "hide my tool" call would silently disable
every other extension's tools and the user's own `--tools` flag along with
it. It reads the current active set first and only adds/removes names within
the caller's own `managedToolNames`, leaving everything else untouched, and
skips the call entirely when nothing would actually change:

```ts
import { refreshVehicleToolAvailability } from "@danypops/vehicle-client-pi";

let registered = await registerVehicleTools(pi, client, { permissions: ["issues:read"] });
setInterval(async () => {
  registered = await refreshVehicleToolAvailability(pi, client, registered, { permissions: ["issues:read"] });
}, 30_000);
```

On the provider side, mark an operation unavailable (or available again) on
`VehicleRegistry` directly -- `registry.setAvailability("jira.search", 1, false, "no Jira credential configured")`
-- and the next `refreshVehicleToolAvailability()` call picks it up.

## What this deliberately does not include

- A routing framework (Hono, itty-router, tRPC): the auth/health/ops routing
  each daemon needs is a handful of `if` branches; a framework would add more
  surface than it removes.
- A replacement for the SQLite migration runner's shape: `PRAGMA user_version`
  is small, already proven across three of the four daemons, and has no known
  bug class a heavier tool (kysely, umzug) would fix.
- A root barrel re-exporting every Vehicle package's surface as one bundle:
  each package's own `exports` map is the intended granularity: import the
  specific subpath a consumer actually needs, not a merged blob of registry,
  HTTP client, and Pi projection code together.

## Status

`packages/daemon-kit/test/walking-skeleton.test.ts` covers bind, auth,
migration, dispatch, maintenance, and shutdown for the daemon substrate.
`packages/vehicle-server/test/vehicle-registry.test.ts` covers the runtime-neutral
`VehicleRegistry`, including `setAvailability()`; `packages/vehicle-client/test/`
covers `LocalVehicleClient` and `RemoteVehicleClient`+HTTP provider parity;
`packages/vehicle-conformance/test/` runs the same shared assertion suite
against both; `packages/vehicle-client-pi/test/vehicle-pi.test.ts` covers the
Pi-native tool projection, including initial active-set curation and
`refreshVehicleToolAvailability()`; `packages/vehicle-client-pi/test/pi-tool-availability.test.ts`
covers the underlying `setActiveTools()` union/diff primitive in isolation.
