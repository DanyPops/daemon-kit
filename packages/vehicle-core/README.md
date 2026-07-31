# @danypops/vehicle-core

Vehicle's runtime-neutral wire contract: operation descriptors, schema
codecs, and failure shapes. Zero runtime dependencies, zero Bun-specific
code -- the one thing every Vehicle client and server package depends on.

```bash
bun add @danypops/vehicle-core
```

`defineVehicleOperation()`/`bindVehicleOperation()` build a serializable
descriptor kept separate from its executable handler. See the
[workspace README](https://github.com/DanyPops/vehicle#readme) for how it
fits with `@danypops/vehicle-server`, `@danypops/vehicle-client`, and
`@danypops/vehicle-client-pi`.

An operation whose result should be read as a narrative rather than parsed
as data can intersect its Output type with `WithVehicleContent` and include
a `content: [{ type: "text", text }]` field alongside its own domain data --
the same field name and shape MCP's `CallToolResult.content` and Pi's own
tool-result type use, so no translation layer is needed at either boundary.
`extractVehicleContent(output)` reads those blocks back out for a generic
Vehicle client to prefer over raw JSON, returning undefined for absent or
malformed content so the caller can fall back safely.
