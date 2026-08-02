# Vehicle starter templates

Three ready-made walking skeletons, one per structural shape found to be the
single biggest cluster of Pi packages hand-rolling a daemon lifecycle, client
reconnection, and ad hoc tool registration from scratch instead of reaching
for Vehicle: subagent/job orchestration, memory/persistent context, and
remote/chat-bridge daemons.

There is no `create-vehicle-app` generator (yet) -- copy the folder matching
your shape into your own project, rename it, `bun install`, and go:

```bash
cp -r job-orchestration ~/my-extension   # or memory/, or chat-bridge/
cd ~/my-extension
bun install
bun test    # confirms the skeleton itself works before you change anything
```

| Template | Shape | Deployment | Real primitive demonstrated |
|---|---|---|---|
| [`job-orchestration/`](./job-orchestration) | Subagent/job/goal orchestration (pi-subagents, pi-crew, pi-fabric, ...) | Monolith (no daemon) | Vehicle Jobs -- submit a background operation, poll it later |
| [`memory/`](./memory) | Memory/persistent context (pi-hermes-memory, pi-vault-mind, ...) | Monolith (no daemon) | Durable local storage via the shared atomic-JSON writer |
| [`chat-bridge/`](./chat-bridge) | Remote/chat-bridge daemon (pi-telegram, pi-gateway, ...) | Split (daemon + HTTP) | One operation reachable both as a Pi tool and over a second inbound webhook route, same process |

Each template's own README explains exactly what to rename/replace first.
See the root [`../README.md`](../README.md)'s "Split vs Monolith" section for
the deployment-shape tradeoff job-orchestration/memory (Monolith) and
chat-bridge (Split) each make deliberately.
