# @danypops/vehicle-client-pi

Projects any `VehicleClient` into native Pi tools -- exact operation
versions, schemas, cancellation, Pi call/session identity, permissions,
keyed idempotency, progress, structured failures, and live tool-visibility
curation by operation availability.

The same package carries the rest of this house's Pi-extension-facing
surface: `./pi-load-harness` (jiti-load-safety verification for any
Pi-loaded module) and the shared `/secrets` Pi command (`./secrets-backend`,
`./secrets-backend-env`, `./secrets-backend-local`, `./secrets-registry`,
`./secrets-tui`) that several extensions in one Pi session merge into.

```bash
bun add @danypops/vehicle-client-pi
```

See the [workspace README](https://github.com/DanyPops/daemon-kit#readme) for
`registerVehicleTools()`/`refreshVehicleToolAvailability()` usage and the full
Vehicle package layout.
