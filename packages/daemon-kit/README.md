# @danypops/daemon-kit

Shared substrate for supervised, authenticated, loopback-only Bun daemons:
process lifecycle, single-instance locking, SQLite storage bootstrap,
structured logging, an HTTP auth/RPC layer, cross-platform service
installation, and a shared secrets UI.

```bash
bun add @danypops/daemon-kit
```

Each concern is its own subpath export (`@danypops/daemon-kit/paths`,
`/daemon`, `/http`, `/pi-client`, etc.) so a consumer only pulls in what it
uses. See the [workspace README](https://github.com/DanyPops/daemon-kit#readme)
for the full module table and the Vehicle SDK packages built alongside it.
