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
operation keeps the generic rendering.

That rendering is the human TUI channel only. What the model itself reads
is separate: an operation's output defaults to raw formatted JSON, but an
operation whose result is meant to be read as a narrative (a workflow run's
summary, a gate report) can include its own `content: [{ type: "text",
text }]` field -- the same field name and shape MCP's `CallToolResult` and
Pi's own tool-result type already use -- and that gets sent to the model
instead. See `extractVehicleContent`/`WithVehicleContent` in
`@danypops/vehicle-core`.

The same package carries the rest of this house's Pi-extension-facing
surface: `./pi-load-harness` (jiti-load-safety verification for any
Pi-loaded module) and the shared `/secrets` Pi command (`./secrets-backend`,
`./secrets-backend-env`, `./secrets-backend-local`, `./secrets-registry`,
`./secrets-tui`) that several extensions in one Pi session merge into.

```bash
bun add @danypops/vehicle-client-pi
```

See the [workspace README](https://github.com/DanyPops/vehicle#readme) for
`registerVehicleTools()`/`refreshVehicleToolAvailability()` usage and the full
Vehicle package layout.
