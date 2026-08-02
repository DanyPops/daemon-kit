# Vehicle template: memory/persistent context

Remember a fact under a key, recall it in a later session -- the shape
pi-hermes-memory, pi-memory, pi-vault-mind, and others all hand-roll
independently. Backed by real durable local storage (atomic temp+rename
writes via the shared `createAtomicJsonWriter`, survives a crash mid-write),
not an in-memory `Map` that forgets everything the moment the process exits.
Monolith Mode (no daemon) -- no HTTP, no port.

## What this demonstrates

- `memory.remember`: writes a fact durably to a local JSON file.
- `memory.recall`: reads it back, reporting `found: false` (not an error) for
  an unknown key.
- `createMemoryFile()`: the storage layer itself, factored out and directly
  testable without going through a `VehicleRegistry` at all.

## What to rename/replace first

1. `memory.remember`/`memory.recall` → your own domain name.
2. `createMemoryFile`'s flat `key -> text` map → your real memory shape
   (embeddings, structured facts, a real database once you outgrow "the
   whole store fits comfortably in memory and on one write").
3. The hardcoded `"./memory.json"` path in the extension's default export →
   a real per-project/per-user path (see `@danypops/vehicle-server/paths`
   for this house's own XDG-aware path conventions).

## Try it live

```bash
bun install
pi --extension ./src/extension.ts --print "remember that my favorite color is blue, then recall it back to me"
```

## When you'd want the daemon-backed Split shape instead

This template is Monolith Mode -- each Pi session gets its own
`VehicleRegistry`, though they all read/write the same file on disk (no
in-process locking against concurrent writers). If several sessions or
processes need one coordinated memory store, move `registerMemoryOperations()`
into a real daemon and swap `LocalVehicleClient` for `RemoteVehicleClient` on
the Pi side -- `memory.remember`/`memory.recall` themselves don't change at
all. See the root README's "Split vs Monolith" section.
