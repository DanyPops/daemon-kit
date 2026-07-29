# @danypops/vehicle-conformance

Host-neutral `bun:test` conformance suite for any `VehicleClient`
implementation -- one shared assertion set that a `LocalVehicleClient`, a
`RemoteVehicleClient`, or any future transport must satisfy identically.
Ships raw TypeScript; a test-time devDependency, not a runtime library.

```bash
bun add -d @danypops/vehicle-conformance
```

```ts
import { registerConformanceOperations, runVehicleClientConformance } from "@danypops/vehicle-conformance";
```

See the [workspace README](https://github.com/DanyPops/daemon-kit#readme) for
the full Vehicle package layout.
