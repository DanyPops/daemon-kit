# Armada

Armada reconciles a user-scoped fleet of local Vehicle daemons through systemd user units, macOS LaunchAgents, or Windows Task Scheduler. Native service managers own the processes; Armada is not a resident supervisor.

## Install

Requires Node.js 22.

```bash
npm install --global @danypops/armada
```

## Manifest

The default manifest is `~/.config/armada/armada.json` on Linux, `~/Library/Application Support/armada/armada.json` on macOS, and `%APPDATA%\Armada\armada.json` on Windows.

```json
{
  "schemaVersion": 1,
  "vehicles": [
    {
      "name": "example",
      "version": "1.0.0",
      "executable": "/absolute/path/to/example",
      "arguments": ["serve"],
      "handlePath": "/absolute/path/to/handle.json",
      "restart": {
        "policy": "on-failure",
        "delayMs": 1000,
        "maxAttempts": 3,
        "windowMs": 60000
      },
      "readiness": {
        "timeoutMs": 5000,
        "pollIntervalMs": 100
      }
    }
  ]
}
```

Credentials and secret-like material are rejected. Executables, working directories, and handle paths must be absolute.

## Commands

```bash
armada plan --json
armada reconcile --json
armada status --json
armada doctor --json
```

Integrations can atomically update one Vehicle without replacing the fleet:

```bash
armada upsert --vehicle-file ./vehicle.json --json
armada reconcile --json
```

Duplicate cleanup is consequence-planned and requires the current hash:

```bash
armada cleanup example --json
armada cleanup example --approve <planHash> --json
```

Remove an Armada-owned service and its manifest declaration with:

```bash
armada remove example --json
```

Use `--manifest <path>` with any command to select a different manifest.

## Development

From the Vehicle repository root:

```bash
bun install
bun run check
bun test packages/armada/test
```
