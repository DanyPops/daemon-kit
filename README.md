# @danypops/daemon-kit

Shared substrate for supervised, authenticated, loopback-only Bun daemons.

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
| `paths` | each daemon's `state.ts` | XDG-compliant path resolution, auth token load-or-create, atomic daemon handle write/read/remove. Loopback-only is a hard invariant here, not a per-daemon option. |
| `storage` | each daemon's `db.ts` | bun:sqlite bootstrap: `foreign_keys`, `busy_timeout`, `journal_mode=WAL`, `optimize`, and a `PRAGMA user_version` migration runner. |
| `logging` | each daemon's `log.ts` (or lack of one) | Structured, credential-safe logging backed by pino, preserving the pre-existing string-level JSON shape so existing log consumers keep working. |
| `http` | each daemon's `service.ts` auth/health scaffolding | Bearer-token check, JSON/error/health/ready response helpers. Deliberately not a routing framework -- each daemon has a handful of routes, too few to justify one. |
| `session-identity` | ad hoc, unverified session-id fields (new) | First-touch capability binding for daemon operations where a caller-supplied session id becomes behavior-affecting, not just an audit label -- a shared bearer token cannot distinguish which client is calling, so a session id alone is not a credential. Storage-agnostic: owns the crypto primitive and a store interface, not a schema. |
| `daemon` | each daemon's `daemon.ts` | Composition root: bind loopback:0, write the handle only after a successful bind, run periodic maintenance tasks (failures logged, never silently swallowed, never crash the daemon), optional idle-timeout self-shutdown, clean SIGINT/SIGTERM. `startDaemon()` is process-signal-free and testable in-process; `runDaemonProcess()` adds the real binary's signal wiring. |
| `rpc-client` | each daemon's `client.ts` | Typed `AuthenticatedRpcClient<Op, Inputs, Outputs>`: `call(op, input)`, `operations()`, `health()`, `ready()` over a single Bearer-authenticated dispatch endpoint. |
| `version` | each daemon's `version.ts` | Reads the running version from the caller's own `package.json` -- the single release source of truth, never hand-duplicated or hardcoded. |

## What this deliberately does not include

- A routing framework (Hono, itty-router, tRPC): the auth/health/ops routing
  each daemon needs is a handful of `if` branches; a framework would add more
  surface than it removes.
- A replacement for the SQLite migration runner's shape: `PRAGMA user_version`
  is small, already proven across three of the four daemons, and has no known
  bug class a heavier tool (kysely, umzug) would fix.

## Status

Walking skeleton: every module has a real, tested implementation, and
`test/walking-skeleton.test.ts` wires all of them into one working daemon
end-to-end (bind, auth, migrate, serve an op, log a maintenance failure,
shut down cleanly) before any of the four real daemons migrate onto it.
