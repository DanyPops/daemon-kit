# @danypops/vehicle-client-pi

Projects any `VehicleClient` into native Pi tools -- exact operation
versions, schemas, cancellation, Pi call/session identity, permissions,
keyed idempotency, progress, structured failures, and live tool-visibility
curation by operation availability.

Every projected tool also gets real `renderCall`/`renderResult` rendering
by default, driven by the operation's own descriptor metadata (`effect`,
name) rather than Pi's generic JSON dump: an effect-colored call row, a
table for array-of-object results, a progress bar for a mid-flight partial
result, and collapsible JSON otherwise -- built on
[`malevich-tui-components`](https://www.npmjs.com/package/malevich-tui-components).
A consumer with real UX investment in one operation can still supply its
own pair via `registerVehicleTools(pi, client, { renderers })`; every other
operation keeps the generic rendering. Call `registerVehicleTools()` from an
async extension factory so Pi has those renderers before replaying persisted
tool rows. Runtime-dependent availability synchronization is deferred to
`session_start` automatically.

That rendering is the human TUI channel only. What the model itself reads
is separate: an operation's output defaults to raw formatted JSON, but an
operation whose result is meant to be read as a narrative (a workflow run's
summary, a gate report) can include its own `content: [{ type: "text",
text }]` field -- the same field name and shape MCP's `CallToolResult` and
Pi's own tool-result type already use -- and that gets sent to the model
instead. See `extractVehicleContent`/`WithVehicleContent` in
`@danypops/vehicle-core`.

A consumer-local side effect the operation's own output can't carry --
e.g. broadcasting on a same-process Pi extension event bus so a sibling
extension can react -- has its own hook: `registerVehicleTools(pi, client,
{ onInvoked })` fires after a successful `invoke()`, before the tool
result is returned. It's deliberately host-local, not part of the
operation's transport-neutral contract (a remote HTTP Vehicle consumer has
no such bus), and never aborts the tool call: an error thrown from
`onInvoked` is swallowed, the same "best-effort broadcast" contract a
direct `pi.events.emit()` call would carry on its own.

The same package carries the rest of this house's Pi-extension-facing
surface: `./pi-load-harness` (jiti-load-safety verification for any
Pi-loaded module), `./multi-select-list` (Malevich's bounded multi-select
state and viewport bound to Pi's theme, ANSI-aware text measurement, and
semantic keymap), `./pi-status-refresh` (`registerVehicleStatusRefresh` --
refresh a footer/widget on `session_start` and again whenever one of this
extension's own projected tools just ran, tolerating a daemon that isn't up
yet), and the shared `/secrets` Pi command (`./secrets-backend`,
`./secrets-backend-env`, `./secrets-backend-local`, `./secrets-registry`,
`./secrets-tui`) that several extensions in one Pi session merge into.

```bash
bun add @danypops/vehicle-client-pi
```

See the [workspace README](https://github.com/DanyPops/vehicle#readme) for
`registerVehicleTools()`/`refreshVehicleToolAvailability()` usage and the full
Vehicle package layout.
