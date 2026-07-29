# @danypops/vehicle-core

Vehicle's runtime-neutral wire contract: operation descriptors, schema
codecs, and failure shapes. Zero runtime dependencies, zero Bun-specific
code -- the one thing every Vehicle client and server package depends on.

```bash
bun add @danypops/vehicle-core
```

`defineVehicleOperation()`/`bindVehicleOperation()` build a serializable
descriptor kept separate from its executable handler. See the
[workspace README](https://github.com/DanyPops/daemon-kit#readme) for how it
fits with `@danypops/vehicle-server`, `@danypops/vehicle-client`, and
`@danypops/vehicle-client-pi`.
