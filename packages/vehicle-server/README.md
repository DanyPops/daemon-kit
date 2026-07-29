# @danypops/vehicle-server

Vehicle's execution engine. Root export is `VehicleRegistry` (registration,
permission/deadline/payload enforcement, availability, execution policy);
`./http` is its authenticated HTTP hosting surface, kept as a separate
subpath so a consumer that only needs the registry never pulls in HTTP
plumbing.

```bash
bun add @danypops/vehicle-server @danypops/vehicle-core
```

See the [workspace README](https://github.com/DanyPops/daemon-kit#readme) for
the full Vehicle package layout.
