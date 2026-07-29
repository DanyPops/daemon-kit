# @danypops/vehicle-client

Vehicle clients: a same-process `LocalVehicleClient` (`./local`) and an
authenticated-HTTP `RemoteVehicleClient` (`./http`). No root export --
each is a real, independent way to reach a `VehicleClient`.

```bash
bun add @danypops/vehicle-client @danypops/vehicle-core
```

See the [workspace README](https://github.com/DanyPops/daemon-kit#readme) for
the full Vehicle package layout.
