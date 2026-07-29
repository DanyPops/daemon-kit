# @danypops/vehicle-client

Every way to reach a Vehicle server: a same-process `LocalVehicleClient`
(`./local`) and an authenticated-HTTP `RemoteVehicleClient` (`./http`), plus
the generic connection-resilience toolkit any client needs -- retry-on-stale-
connection, auto-spawn/fail-closed policy, version checking, push-channel
reconnection, and authenticated RPC over HTTP (`./rpc-client`) or a Unix
socket (`./unix-rpc-client`). No root export -- each subpath is a real,
independent capability; importing one must never pull in another it doesn't
need.

```bash
bun add @danypops/vehicle-client @danypops/vehicle-core
```

`./daemon-client` and `./unix-rpc-client` are shipped pre-compiled
specifically for Pi's jiti extension loader; `./rpc-client` and `./version`
ship as raw TypeScript.

See the [workspace README](https://github.com/DanyPops/vehicle#readme) for
the full module table and Vehicle package layout.
