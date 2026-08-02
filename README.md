# Vehicle workspace

A runtime-neutral Vehicle SDK for agent tools (`@danypops/vehicle-*`), as a
Bun workspace of independently versioned, independently publishable packages
under `packages/*`. A Vehicle is a long-running service purpose-built to
serve AI agents tools -- so the daemon substrate (process lifecycle, storage,
auth, logging) lives directly inside `@danypops/vehicle-server` and
`@danypops/vehicle-client`, not as a separate dependency they each pull in.

## Getting started

The fastest path to a working Vehicle-backed Pi extension is copying one of
three ready-made starter templates in [`templates/`](./templates) and
renaming it -- not reading this whole README and wiring `vehicle-core`/
`vehicle-server`/`vehicle-client-pi` together from scratch:

```bash
cp -r templates/job-orchestration ~/my-extension   # or templates/memory, or templates/chat-bridge
cd ~/my-extension && bun install && bun test
```

Pick by shape: **job-orchestration** and **memory** are Monolith Mode (no
daemon); **chat-bridge** is the daemon-backed Split shape. See
[`templates/README.md`](./templates/README.md) for the full comparison, and
"Split vs Monolith" below for the deployment-shape tradeoff itself.

## Why this exists

Four independent daemons (`web-spider-daemon`, `jittor`, `papyrus`,
`pi-packed`) each hand-rolled the same problem: an XDG-path-resolved,
Bearer-token-authenticated, loopback-only Bun service backed by SQLite, with
a typed RPC client on the other end. Two of the four originals' own header
comments admitted the duplication ("mirrors jittor/src/state.ts exactly").
This workspace is that shared substrate, factored out after the fact once
four real implementations existed to compare, and later merged directly into
the Vehicle server/client packages once it became clear that substrate
*is* what a Vehicle server and client actually are -- not infrastructure a
Vehicle happens to depend on.

Vehicle's own operation-invocation layer (descriptors, schema codecs, failure
shapes, permissions, idempotency, deadlines, cancellation, progress) is kept
in a separate zero-dependency `vehicle-core` package: a real npm package with
its own version and its own `exports` map, not a barrel re-exporting
unrelated concerns under one bundle. A consumer that only needs
`VehicleRegistry` never pulls in an HTTP client or a Pi projection it isn't
using.

## Workspace layout

| Package | Depends on (workspace) | Role |
|---|---|---|
| `@danypops/vehicle-core` | -- | Vehicle's wire contract: operation descriptors, schema codecs, failure shapes. Zero runtime dependencies, zero Bun-specific code. |
| `@danypops/vehicle-server` | `vehicle-core` | The daemon itself: process lifecycle, SQLite storage bootstrap, structured logging, HTTP auth/RPC scaffolding, OS service installation, credential vault, process supervision -- plus `VehicleRegistry` (execution engine) at `.` and its authenticated HTTP hosting surface at `./http`. See its own module table below. |
| `@danypops/vehicle-client` | `vehicle-core`, `vehicle-server` | Every way to reach a Vehicle server: `LocalVehicleClient` at `./local`, `RemoteVehicleClient` at `./http`, plus the generic connection-resilience toolkit (retry, auto-spawn policy, version check, push-channel reconnection, RPC over HTTP or a Unix socket) any client needs. See its own module table below. |
| `@danypops/vehicle-client-pi` | `vehicle-core`, `vehicle-server` | Projects any `VehicleClient` into native Pi tools, with live availability curation, plus the rest of this house's Pi-extension-facing surface: jiti-load-safety verification and the shared `/secrets` command. |
| `@danypops/vehicle-conformance` | `vehicle-core`, `vehicle-server` | Host-neutral `bun:test` conformance suite any `VehicleClient` implementation must satisfy identically. Ships raw TypeScript -- a test-time devDependency, not a runtime library. |

## `@danypops/vehicle-server` modules

Each module is independently importable (`@danypops/vehicle-server/paths`,
etc.) so a consumer only pulls in what it uses.

| Module | Replaces | Responsibility |
|---|---|---|
| `paths` | each daemon's `state.ts` | Cross-platform path resolution (Linux: XDG; macOS: ~/Library/Application Support etc.; Windows: %LOCALAPPDATA%/%APPDATA%), cross-checked in tests against `env-paths` without taking it as a runtime dependency. Single-instance lock (`acquireDaemonLock`/`releaseDaemonLock`, atomic wx-create with dead-pid theft) so exactly one daemon process ever binds. Auth token load-or-create, atomic daemon handle write/read/remove. Loopback-only is a hard invariant here, not a per-daemon option. |
| `storage` | each daemon's `db.ts` | bun:sqlite bootstrap: `foreign_keys`, `busy_timeout`, `journal_mode=WAL`, `optimize`, and a `PRAGMA user_version` migration runner. The version-gap/downgrade-checking migration engine (`runMigrations`) is generic over a small `SqliteMigrationRunner<Handle>` port, so a storage layer that isn't bun:sqlite-shaped (e.g. node:sqlite, or a project's own dual-runtime `Db` abstraction) can reuse it via its own adapter, without editing this module. |
| `logging` | each daemon's `log.ts` (or lack of one) | Structured, credential-safe logging backed by pino, preserving the pre-existing string-level JSON shape so existing log consumers keep working. |
| `rpc-http` | each daemon's `service.ts` auth/health scaffolding | Bearer-token check, JSON/error/health/ready response helpers. Deliberately not a routing framework -- each daemon has a handful of routes, too few to justify one. Also backs `VehicleRegistry`'s own `./http` provider directly. |
| `session-identity` | ad hoc, unverified session-id fields (new) | First-touch capability binding for daemon operations where a caller-supplied session id becomes behavior-affecting, not just an audit label -- a shared bearer token cannot distinguish which client is calling, so a session id alone is not a credential. Storage-agnostic: owns the crypto primitive and a store interface, not a schema. |
| `daemon` | each daemon's `daemon.ts` | Composition root: acquire the single-instance lock before binding anything (a losing concurrent start rejects with `DaemonAlreadyRunningError` and never binds a port -- runDaemonProcess() treats that as a normal join, exit 0, not a crash), bind loopback:0, write the handle only after a successful bind, run periodic maintenance tasks (failures logged, never silently swallowed, never crash the daemon), idle-timeout self-shutdown, clean SIGINT/SIGTERM. **Runtime-dual**: Bun (`Bun.serve`) or plain Node (`node:http`), runtime-detected the same way `storage.ts` already does for SQLite -- `buildApp()`'s `{ fetch(Request): Promise<Response> }` contract is already Web-standard, so nothing above that layer changes; verified against a real spawned `node` process, not just at the type level. `pushChannel` (see `push-channel`) requires Bun (WebSocket upgrade) -- passing one under Node rejects with an actionable error rather than silently degrading. `startDaemon()` is always async (Node's `listen()` cannot bind synchronously the way `Bun.serve()` does). Idle shutdown defaults from an env-provided launch provenance (auto-spawned vs. service-installed) unless an explicit `idleBudgetMs` is given. `runDaemonProcess()` adds the real binary's signal wiring. Shipped pre-compiled (`./daemon` -> `dist/daemon.js`, bundled with `paths`/`rpc-http`/`logging`/`push-channel`) via `bun run build:daemon` -- Node refuses to type-strip *any* `.ts` file under `node_modules` (a permanent policy, confirmed directly against Node's own docs, not a missing flag), and a real consumer's own `tsc` build has no `Bun` global type available -- both real blockers for a plain-Node consumer of raw source, both closed by compiling instead. |
| `service` | web-spider-daemon's bespoke systemd --user unit writer, and nonexistent everywhere else | Cross-platform login/boot persistence: `installUserService()`/`uninstallUserService()`/`isServiceInstalled()` generate and register a systemd --user unit (Linux, init-system-detected by binary presence, not assumed), a launchd user agent plist (macOS), or an HKCU Run registry value via `reg.exe` (Windows, no elevation, no native dependency). Deliberately not a process supervisor -- no `Restart=`/`KeepAlive` -- since connectWithPolicy's auto-spawn plus the single-instance lock already resurrect the daemon lazily on next use regardless of platform; this module's only job is getting one started once after login. |
| `process-supervisor` | Enigma's own `src/supervisor.ts` (restart-policy interpretation, a credential-refresh restart, the shutdown contract) | `runProcessSupervisor()` builds on `supervisor.ts`'s minimal `spawnUnit()`: restart-policy interpretation (`always`/`on-failure`/`no`), a `shouldPlannedRestart` predicate checked on a timer that kills-and-relaunches bypassing restart policy entirely (for a reason other than a crash), an explicit `restartUnit(name)` escape hatch independent of that timer, and the shutdown contract (graceful shutdown -- see below -- to every unit, `stop()` resolves only once all have actually exited). `resolveEnv` is called fresh at every (re)launch, not once at supervisor start. Generic on purpose -- a caller's own secret resolution and freshness predicate are supplied as callbacks, never hardcoded here. |
| `supervisor` (graceful shutdown) | Enigma's own `process.on("SIGTERM", ...)` fixture/unit code, which silently doesn't work on Windows | `spawnUnit()`'s `requestGracefulShutdown()` sends a real SIGTERM on POSIX (unchanged), or -- on Windows, where `ChildProcess.kill("SIGTERM")` unconditionally terminates the process without ever invoking a handler -- writes a magic line to the unit's stdin instead (stdin is now piped, not ignored, specifically to make this possible). `awaitGracefulShutdown()` is the unit-side counterpart: a unit calls it once at startup to react identically to a real POSIX signal or the Windows stdin fallback, without needing its own platform branch. `platform` is injectable on `spawnUnit()` (mirroring `paths.ts`/`service.ts`'s own convention) so the Windows code path is exercised in CI on any host OS. |
| `vault` | pipes' token-provider.ts, pipes' per-backend file stores, tickets' token-store.ts | Shared OAuth/credential machinery for a daemon that authenticates to an external service on the user's behalf: plaintext (`createFileStore`) or AES-256-GCM-encrypted-at-rest (`createEncryptedFileStore`) per-backend token storage, and `createTokenProvider()` -- a `getToken()` an adapter calls before every request, sharing one in-flight refresh across concurrent callers so two racing refreshes never burn a single-use rotating refresh token. |
| `unix-peer-cred` / `unix-rpc-server` | nothing (new) | A Fetch-API-shaped RPC handler served over a Unix domain socket with the kernel-verified caller's SO_PEERCRED credential attached to every request -- Bun/node:http expose no peer credentials for Unix sockets, so this uses `Bun.listen()` for raw fd access and a custom newline-delimited JSON frame instead of real HTTP/1.1. |
| `version` | each daemon's `version.ts` | Reads the running version from the caller's own `package.json` -- the single release source of truth, never hand-duplicated or hardcoded. Also duplicated (unchanged) into `vehicle-client`, since a client-side consumer has no other reason to depend on this package. |
| `push-channel` | nothing -- Papyrus's Task widget could previously only poll on a fixed interval (new) | `PushChannel` wires an optional authenticated WebSocket upgrade into `startDaemon()` (`GET /push?token=...`, query-string token since the WebSocket constructor cannot set an Authorization header) alongside the existing fetch-based RPC. `publish(topic, payload)` broadcasts to every subscriber of that topic the moment a mutation happens, instead of every client waiting out a poll interval. Bounded connection count and topics-per-connection. Pairs with `vehicle-client`'s `connectPushChannel()`. Shipped pre-compiled (`./push-channel` -> `dist/push-channel.js`, built together with `daemon`) so a `PushChannel` built through this export shares one type identity with `startDaemon()`'s own `pushChannel` option. |

## `@danypops/vehicle-client` modules

| Module | Replaces | Responsibility |
|---|---|---|
| `rpc-client` | each daemon's `client.ts` | Typed `AuthenticatedRpcClient<Op, Inputs, Outputs>`: `call(op, input)`, `operations()`, `health()`, `ready()` over a single Bearer-authenticated dispatch endpoint. |
| `daemon-client` | each Pi extension's own retrying-client copy (lector's `lectorClient()`, web-spider's `callWebSpider()`, papyrus's `callService()`, pi-packed's `createNatives()`) and their independently-forked auto-start policy | `createRetryingClient()`: caches a connected client and retries exactly once against a freshly reconnected one on a stale-connection error (the daemon rebinds a random port on every restart), and fails fast via a circuit breaker after sustained connect failures instead of paying a full connect timeout on every call. `connectWithPolicy()`: one explicit `autoStart` flag (default false, fail closed) instead of a silent per-daemon fork between failing closed and transparently spawning the daemon. `connectWithVersionCheck()`: detects a daemon left running from before an extension upgrade and transparently replaces it. `spawnDetachedDaemon()`: platform-correct spawn options (Windows console-hiding) for the four independent `spawn()` callbacks. `connectPushChannel()`: subscribes to a daemon's push-invalidation channel with real reconnection -- exponential backoff gated by a minimum-uptime window, jittered to avoid a reconnect storm when several Pi sessions reconnect to the same restarted daemon at once, plus a heartbeat ping/timeout to catch a socket that stays open while the daemon itself is hung. `createReconnectingVehicleClient(connect)`: wraps `createRetryingClient` as a drop-in `VehicleClient` -- pass it to `registerVehicleTools()` instead of a bare `new RemoteVehicleClient(...)` so a Pi session survives a daemon restart without a full extension reload. `manifest()` retries transparently (read-only, always safe); `invoke()` uses the separate `callOnce()` method -- connects fresh when needed but never silently re-runs a mutating operation a second time, so a real in-flight failure still surfaces to the caller exactly once instead of risking a duplicate side effect, while the *next* call (a model's own retry, or the next scheduled manifest refresh) reconnects and succeeds. Has no RUNTIME imports of its own (fetch/Request/TypeError/AbortError/WebSocket are all global; the one VehicleClient type import is erased at compile time), so it loads safely under Node without a Bun runtime -- shipped pre-compiled via `bun run build:daemon-client` anyway, since Pi's jiti loader has a real, demonstrated failure class importing a dependency's raw, unbuilt TypeScript. |
| `unix-rpc-client` | nothing (new) | Client counterpart to `vehicle-server`'s `unix-rpc-server`, same wire framing, built on `node:net` (not `Bun.connect`) so it works under Pi's own Node process. No identity material needed client-side -- SO_PEERCRED is kernel-enforced server-side. |

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
and `POST /vehicle/cancel`, Bearer-authenticated via this same package's own
`./rpc-http`. Kept as a separate subpath from the root export on purpose: a
consumer that only builds/tests a registry never pulls in HTTP request/response
plumbing.

`@danypops/vehicle-client` has no root export -- `./local` (`LocalVehicleClient`,
a same-process client wrapping a `VehicleRegistry` directly) and `./http`
(`RemoteVehicleClient`, authenticated HTTP with the same semantics as local)
are each a real, independent way to reach a `VehicleClient`; importing one must
never pull the other in. `RemoteVehicleClient` accepts an opt-in
`manifestCacheTtlMs` (default off -- every `manifest()` call hits
`/vehicle/manifest` fresh, today's exact behavior): when set, a call within
the TTL is served from a single cached slot instead of a new HTTP round trip,
and the cache is invalidated automatically the moment a non-`"read"`-effect
`invoke()` through that same client succeeds -- looked up against the cached
manifest itself, never a fresh fetch, so an operation this client has never
seen via `manifest()` is left alone rather than guessed at.

`@danypops/vehicle-client-pi` projects a `VehicleClient` manifest into native
Pi tools. It preserves exact operation versions, schemas, cancellation, Pi
call/session identity, explicit permissions and principals, keyed idempotency,
progress, and structured failures. A gated-effect operation (see "Approval
Gate" below) requires a real, verified approval capability -- opt-in per
deployment, never forced on a Vehicle that never configures it. A currently-unavailable operation (per the
manifest's `available` flag) -- or one whose declared `permissions` aren't
fully covered by this registration's own `options.permissions`, the exact
superset check `VehicleRegistry.invoke()` already enforces at call time,
applied here to visibility instead -- is still registered as a Pi tool -- Pi
has no `unregisterTool()` -- but curated out of the LLM's active/callable set
from the very first `registerVehicleTools()` call via its own
`syncManagedActiveTools` primitive (Vehicle-agnostic, exported separately for
any Pi extension curating its own tool visibility, not just this one). A
caller never sees a tool it has no permissions to call in the first place --
a wasted turn is the mild failure mode a pure invoke-time check leaves open;
the tool's mere presence in the system prompt, leaking the existence of a
capability the caller was never meant to know about, is the one this closes.
`refreshVehicleToolAvailability()` re-fetches the manifest on whatever
cadence the caller chooses (a maintenance-task interval, a push notification,
a session_start recheck) and re-syncs active/inactive state for known tools --
including permission eligibility, so a caller whose granted permissions
change mid-session (a token upgrade, a delegated-scope change) gets tools
revealed/hidden correctly without a full extension reload --
registering any genuinely new operation for the first time.

The same package also carries the shared `/secrets` Pi command
(`secrets-backend`, `secrets-backend-env`, `secrets-backend-local`,
`secrets-registry`, `secrets-tui`): a `SecretsBackend` port (`list`/`get`
redacted `SecretRecord`s, `rotate`/`revoke`, and `reveal` -- the one
deliberate unredacted exception, refused outright outside a real interactive
TUI session), an env-var backend and a `vehicle-server`-vault-backed local
backend, and a process-wide registry so several Pi extensions sharing one
session (Enigma, Pipes, Tickets) merge into one `/secrets` command instead of
each registering its own.

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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const client = createIssuesVehicleClient();
    await registerVehicleTools(pi, client, {
      permissions: ["issues:read"],
      principal: { id: "pi-extension" },
      closeClientOnSessionShutdown: true,
    });
  });
}
```

**Call `registerVehicleTools()` from within a `pi.on("session_start", ...)` handler
(or later) -- never directly from the extension's top-level factory body, even
if the factory is itself `async` and its promise is awaited.** Pi's extension
runtime only finishes initializing after every extension's factory has
resolved; `registerVehicleTools()` needs `pi.getAllTools()` (collision
detection) and `pi.getActiveTools()`/`setActiveTools()` (activation sync),
both of which throw `"Extension runtime not initialized"` when called too
early. Confirmed live, twice, independently, in two different real Vehicle-based
extensions that called it directly from the top-level factory -- both had
every one of their projected tools silently invisible to the model, with the
underlying error swallowed by each extension's own daemon-unreachable
try/catch. `registerVehicleTools()` now turns that specific failure into a
clear, actionable error instead of leaking Pi's cryptic one-liner or being
swallowed silently several frames up -- but the fix is still to call it from
`session_start`, not to rely on the clearer error message.

Operation names are projected to Pi-safe names (`issues.search`
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

// Both calls assume they're running from within (or after) session_start --
// same requirement as registerVehicleTools() itself, see above.
let registered = await registerVehicleTools(pi, client, { permissions: ["issues:read"] });
setInterval(async () => {
  registered = await refreshVehicleToolAvailability(pi, client, registered, { permissions: ["issues:read"] });
}, 30_000);
```

On the provider side, mark an operation unavailable (or available again) on
`VehicleRegistry` directly -- `registry.setAvailability("jira.search", 1, false, "no Jira credential configured")`
-- and the next `refreshVehicleToolAvailability()` call picks it up.

### Split vs Monolith: two equally first-class deployment shapes

Everything above assumes the **Split** shape: `VehicleRegistry` runs in a
separate daemon process, a Pi extension talks to it over HTTP via
`RemoteVehicleClient`. That's the right choice whenever a Vehicle's state
must survive a Pi session ending, or several sessions/processes need to share
one provider. It is not the only choice, and Vehicle should never force it on
a consumer that doesn't need it -- Vehicle is boilerplate, not a framework.

**Monolith** is the other first-class shape: no daemon, no HTTP, no port, no
systemd unit. The provider and its one consumer share a process --
`createMonolithVehicle` (`@danypops/vehicle-client-pi/monolith`) bundles a
fresh `VehicleRegistry`, a `LocalVehicleClient` wrapping it directly (zero
network), and `registerVehicleTools()` projecting its operations onto real Pi
tools, into one call:

```ts
import { createMonolithVehicle } from "@danypops/vehicle-client-pi/monolith";
import { defineVehicleOperation, bindVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";

pi.on("session_start", async () => {
  await createMonolithVehicle(pi, { name: "echo-vehicle", version: "1.0.0", description: "..." }, (registry) => {
    const echo = defineVehicleOperation({ name: "echo.say", version: 1, /* ...same shape as any daemon-backed operation... */ });
    registry.register("echo", bindVehicleOperation(echo, () => async (context) => ({ text: context.input.text })));
  });
});
```

A Monolith provider's own operations are defined exactly the same way a
daemon-backed one's are (`defineVehicleOperation`/`bindVehicleOperation`
against the same `registry.register()`) -- upgrading to a real daemon later
means moving that same `register` callback into a service process and
swapping `LocalVehicleClient` for `RemoteVehicleClient`, not rewriting any
operation. See `packages/vehicle-client-pi/examples/monolith-echo-extension.ts`
for a complete, runnable extension (`pi --extension ./monolith-echo-extension.ts --print "..."`
works with nothing else running).

**When to pick which:**

| | Split (daemon + HTTP) | Monolith (in-process) |
|---|---|---|
| State must outlive the Pi session | Yes -- this is the whole point | No -- gone when the session ends |
| Multiple sessions/processes share one provider | Yes | No -- one process, one consumer |
| Setup | A daemon, a port, a systemd unit (or manual start) | Nothing -- just the extension |
| Upgrade path | N/A -- already the durable shape | Move `register()` into a daemon, swap the client |

### Surviving a daemon restart

`registerVehicleTools()` captures whatever `VehicleClient` you pass it forever,
in every registered tool's closure. A daemon binds a new random port on every
restart (crash, upgrade, manual `systemctl restart`); a bare
`new RemoteVehicleClient({baseUrl, token})` built once at `session_start` has no
way to notice its `baseUrl` is now dead. **Confirmed live**: every Vehicle tool
call in an already-running Pi session failed with a bare connection error
until the whole extension reloaded. Pass `createReconnectingVehicleClient()`
(`@danypops/vehicle-client`) instead:

```ts
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";

const client = createReconnectingVehicleClient(async () => {
  // Re-resolve the daemon's CURRENT handle (host/port/token) on every
  // reconnect attempt -- a value captured once outside this factory would
  // reintroduce the exact bug this fixes.
  const target = await resolveCurrentVehicleTarget();
  return new RemoteVehicleClient({ baseUrl: target.baseUrl, token: target.token });
});
await registerVehicleTools(pi, client, { permissions: ["issues:read"] });
```

`manifest()` retries transparently -- always safe, since it's read-only and
idempotent, so a scheduled `refreshVehicleToolAvailability()` call (see above)
self-heals the connection with zero visible failure. `invoke()` deliberately
does **not** auto-retry: Vehicle's own idempotency model (`safe`/`keyed`/
`unsafe`) is real per-operation information this generic wire-level wrapper
can't safely generalize over, so a mutating call that genuinely fails against
a dead connection still surfaces that failure to the caller exactly once --
never silently repeated -- while dropping the stale connection so the *next*
call (the model's own retry after seeing a tool error, or the next
`refreshVehicleToolAvailability()` tick) reconnects and succeeds. Built on
`createRetryingClient`'s new `callOnce()` method -- connect-with-caching and
circuit-breaking identical to `call()`, but the operation itself is never
retried after a failure, only the underlying connection is dropped for next
time.

### Approval Gate

`VehicleRegistry.configureApprovals()` is opt-in -- a Vehicle that never calls
it keeps today's exact `manifest()` shape and `invoke()` behavior (no gating
at all, no `vehicle.approval.resolve` operation, no `vehicle.approval.*`
events). Calling it turns on real, verified approval for a configurable set
of effects:

```ts
import { HmacApprovalAuthority } from "@danypops/vehicle-server/approval-authority";

registry.configureApprovals({
  // Defaults to ["destructive", "open-world"]. A ticketing/PR-facing Vehicle
  // can add "external-write" without forcing that requirement on every other
  // Vehicle in the ecosystem.
  requireApprovalForEffects: ["destructive", "open-world", "external-write"],
  authority: new HmacApprovalAuthority(), // default if omitted
  timeoutMs: 5 * 60_000, // default: how long a request stays resolvable
});
```

A gated `invoke()` with no capability (or an invalid one) never just fails
with a dead end: it durably records a `vehicle.approval.requested` Vehicle
Event first (operation, effect, principal, a bounded expiry), *then* throws a
retryable `approval-required` failure carrying the request's id. Any
authority -- a human at the same Pi session, a remote approver polling the
event stream, `@agentapprove/pi`-style phone approval -- resolves it via the
registry's own built-in `vehicle.approval.resolve` operation (permission:
`vehicle:approvals:resolve`), which mints a real HMAC-signed capability on
`"granted"` and nothing on `"denied"`. That capability is scoped to the exact
operation, version, and input it was requested for, expires with its
request, and is single-use -- presenting an arbitrary non-empty string (or a
capability minted for different input) is rejected outright, closing the gap
where any truthy string used to satisfy the check.

`registerVehicleTools()` wires the interactive half of this automatically:
when a Pi tool call gets back `approval-required` and `ctx.hasUI` is true, it
shows a `ctx.ui.confirm()` prompt (2-minute default timeout, denies on
timeout/abort/any UI error -- fails closed, never silently grants) and
retries the original call with whatever capability `vehicle.approval.resolve`
returns. No UI, or no requestId in the failure -- the request stays durably
pending for an async/remote resolution instead of this call eagerly denying
it on the caller's behalf.

### Scheduler

`VehicleScheduler` (`@danypops/vehicle-server/scheduler`) is a distinct primitive from Vehicle Jobs: a Job tracks a unit of work already running; a Scheduler triggers something at a future time or on a recurring interval, independent of any job's own lifecycle.

```ts
import { VehicleScheduler } from "@danypops/vehicle-server/scheduler";
import { createFileVehicleSchedulePersistence } from "@danypops/vehicle-server/schedule-persistence";

const scheduler = new VehicleScheduler(registry, {
  persistence: createFileVehicleSchedulePersistence({ filePath: "schedules.json", fs }),
});
await scheduler.restore(); // call once at daemon startup, before serving any request

const handle = scheduler.schedule(
  "my-provider",
  { kind: "every", intervalMs: 60_000 }, // or { kind: "at", at: someEpochMs } for a one-shot
  { kind: "operation", name: "issues.sync", version: 1, input: {}, permissions: ["issues:write"] },
);
handle.cancel();
```

A fired action is always declarative -- invoke a named Vehicle operation or
emit a named Vehicle Event -- never a bespoke callback closure, so it
survives a restart. `restore()` re-arms every persisted entry: a one-shot
that fell overdue while the daemon was down fires as soon as possible (the
one thing it was supposed to do is never silently lost); a recurring entry
resumes its normal cadence from now rather than firing once per missed
tick. Bounded per owner the same way `WatchRegistry` bounds watches per
scope -- `VehicleScheduleLimitExceeded` once an owner's cap is hit.

### Activity Broker

A cross-extension, best-effort side channel for structured telemetry -- ported from vstack's (github.com/vanillagreencom/vstack) `pi-background-tasks` activity broker. Completely decoupled from the chat transcript: a Vehicle-projected Pi tool and a dashboard/logger extension never import each other, they just agree on one `globalThis` symbol and an event shape.

`registerVehicleTools()` publishes `vehicle.operation.started`/`completed`/`failed` events for every invocation automatically -- opt-in by construction, not by an option flag: publishing is a true no-op until some other extension actually registers a broker.

```ts
import { registerActivityBroker } from "@danypops/vehicle-client-pi/activity-broker";

// In a dashboard/logger extension, once per process:
registerActivityBroker({
  publish(event) {
    if (event.severity === "error") logger.warn(event.summary, event.details);
  },
});
```

A broker's own `publish()` throwing, or no broker being registered at all, never affects the Vehicle tool call it's reporting on -- the same "activity publication is best-effort" contract vstack's original ships.

### `/safety` command

One place to see and control every registered Vehicle's projected-tool
policy (`allow`/`ask`/`blocked`), instead of it being scattered across each
Vehicle's own registration-time options. `registerVehicleTools()` and
`refreshVehicleToolAvailability()` contribute to a shared, process-wide
registry unconditionally -- the same "opt-in by construction" convention the
Activity Broker uses -- so `/safety` sees every Vehicle a session has
registered with zero extra wiring.

```ts
import { registerVehicleSafetyCommand } from "@danypops/vehicle-client-pi/safety-command";
import { VehicleSafetyPolicyStore, createFileVehicleSafetyPersistence } from "@danypops/vehicle-client-pi/vehicle-safety";

const policyStore = await VehicleSafetyPolicyStore.restore(
  createFileVehicleSafetyPersistence({ filePath: "safety.json", fs: createNodeAtomicJsonFsAdapter() }),
);
registerVehicleSafetyCommand(pi, policyStore);

// Pass the same store into every Vehicle's own registration so overrides
// actually take effect:
await registerVehicleTools(pi, client, { safetyPolicyStore: policyStore });
```

Each operation's state resolves by precedence: an explicit per-operation
override (a human's own `/safety` decision) always wins, then the
effect-level default (`requireApprovalForEffects`, mirroring the Approval
Gate's own set), then a missing permission blocks. An override winning over
a permission-based block only changes local visibility/gating -- it never
bypasses what the server actually authorizes; invoking a permission-blocked
operation a human overrode to `allow` still fails server-side with
`permission-denied`. An override of `ask` also gates `execute()` itself with
a local `ctx.ui.confirm()` before ever calling `invoke()`, for an effect the
effect-level default wouldn't otherwise catch.

`/safety` Tab-cycles three views (All, Allowed, By effect) over every known
operation, built on Malevich's `TabbedContainer`/`Table`; editing closes the
panel and runs two short picks (which operation, then which new state) that
write through to the policy store -- effective the moment the affected
Vehicle's own next `refreshVehicleToolAvailability()` call re-reads it.

### Interactive follow-ups

A `registerVehicleTools()` option for the rare operation whose real UX needs
more than "call it, show the output" -- e.g. an operation that durably
records something and separately wants to offer a synchronous human
round-trip when `ctx.hasUI` allows one. Distinct from the Approval Gate's own
local-confirm fast path (baked into every gated operation identically):
this is a per-operation, per-consumer escape hatch for a shape nothing else
shares.

```ts
await registerVehicleTools(pi, client, {
  interactiveFollowUps: (descriptor) =>
    descriptor.name === "discuss.open" || descriptor.name === "discuss.reply"
      ? async (_request, output, followUpClient) => {
          const question = (output as { rounds: { content: string }[] }).rounds[0]?.content;
          // ...show a local prompt, then optionally call followUpClient.invoke("discuss.reply", ...)
          return { content: [{ type: "text", text: "..." }], output: { answered: true } };
        }
      : undefined,
});
```

Returning `undefined` (the default for every operation the resolver doesn't
name) falls back to the operation's own default content/details -- zero
behavior change for every consumer that never sets this option. A thrown
error propagates as a real tool failure; the primary `invoke()` already
succeeded and is never rolled back.

Pair it with `executionMode` when the follow-up prompts a human
synchronously -- `"sequential"` stops the model from batching that call
alongside other tool calls in the same turn and letting those run before the
human sees the prompt:

```ts
await registerVehicleTools(pi, client, {
  executionMode: (descriptor) => (descriptor.name === "discuss.open" ? "sequential" : undefined),
});
```

## One operation per real action, never an action-dispatch tool

A recurring anti-pattern in agent tool design -- documented independently as
"God Parameters"/"Kitchen Sink tool" (IBM's MCP integration guidance, several
agent-tooling blogs) and covered in Anthropic's own writing-tools-for-agents
post -- is one tool with an `action` enum branching into many otherwise-
unrelated operations, backed by a shared parameter blob that's a superset
union across every branch. A real audit of this house's own Pi tools found
exactly this shape at real scale: a 38-action, 33-parameter tool with its
`action` field left completely unconstrained (`Type.String()`, not even an
enum), so an invalid action isn't rejected until it reaches the daemon.

Define every real action as its own `VehicleOperation` instead, each with its
own honest `effect`/`idempotency`/schema -- never an operation whose own
input schema is itself an `action`-dispatch blob. This isn't just a style
preference: `VehicleOperationDescriptor` requires exactly one `effect` per
operation, so folding a destructive action (delete) and a read action (list)
behind one shared `action` parameter forces a dishonest blended `effect` --
either reads get gated as destructive, or deletes slip through ungated.
There's no equivalent cost to doing this with a raw `pi.registerTool()` call,
which is exactly how the anti-pattern accumulates unchecked.

Namespace many related operations under one provider with a shared dotted
name prefix (`tasks.create`, `tasks.list`, `tasks.remove`, ...) rather than
collapsing them into one tool -- `registerVehicleTools()`'s existing name
projection already turns this into distinct, correctly prefixed Pi tools
(`tasks_create`, `tasks_list`, `tasks_remove`) with no extra code, and two
providers using the same short action words (`notes.create` vs
`tasks.create`) never collide. This is the same "namespacing" alternative to
consolidation Anthropic's own guidance recommends, not something novel to
Vehicle. Proven at the scale that actually motivates reaching for a
mega-tool in `packages/vehicle-client-pi/test/namespaced-operations-at-scale.test.ts`,
which models a real 38-action tool this way and checks every operation
projects to a distinct, collision-free tool with its own narrow schema and
honest effect intact.

## What this deliberately does not include

- A routing framework (Hono, itty-router, tRPC): the auth/health/ops routing
  each daemon needs is a handful of `if` branches; a framework would add more
  surface than it removes.
- A replacement for the SQLite migration runner's shape: `PRAGMA user_version`
  is small, already proven across three of the four daemons, and has no known
  bug class a heavier tool (kysely, umzug) would fix.
- A root barrel re-exporting every package's surface as one bundle: each
  package's own `exports` map is the intended granularity -- import the
  specific subpath a consumer actually needs, not a merged blob of registry,
  HTTP client, and Pi projection code together.

## Status

`packages/vehicle-server/test/walking-skeleton.test.ts` covers bind, auth,
migration, dispatch, maintenance, and shutdown for the daemon substrate.
`packages/vehicle-server/test/vehicle-registry.test.ts` covers the runtime-neutral
`VehicleRegistry`, including `setAvailability()`; `packages/vehicle-client/test/`
covers `LocalVehicleClient` and `RemoteVehicleClient`+HTTP provider parity;
`packages/vehicle-conformance/test/` runs the same shared assertion suite
against both; `packages/vehicle-client-pi/test/vehicle-pi.test.ts` covers the
Pi-native tool projection, including initial active-set curation and
`refreshVehicleToolAvailability()`; `packages/vehicle-client-pi/test/pi-tool-availability.test.ts`
covers the underlying `setActiveTools()` union/diff primitive in isolation.
