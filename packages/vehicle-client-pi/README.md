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
