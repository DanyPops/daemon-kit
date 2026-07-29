# @danypops/vehicle-server

The Vehicle server substrate: a supervised, authenticated, loopback-only
daemon (process lifecycle, SQLite storage, structured logging, OS service
install, credential vault, process supervision) plus `VehicleRegistry`
(registration, permission/deadline/payload enforcement, availability,
execution policy) at `.` and its authenticated HTTP hosting surface at
`./http`. A Vehicle IS this daemon -- a long-running service purpose-built
to serve AI agents tools.

```bash
bun add @danypops/vehicle-server @danypops/vehicle-core
```

Every other module (`./paths`, `./storage`, `./logging`, `./rpc-http`,
`./daemon`, `./service`, `./supervisor`, `./process-supervisor`, `./vault`,
`./session-identity`, `./unix-peer-cred`, `./unix-rpc-server`,
`./push-channel`, `./version`) is independently importable, so a consumer
only pulls in what it uses.

See the [workspace README](https://github.com/DanyPops/vehicle#readme) for
the full module table and Vehicle package layout.
