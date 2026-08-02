# Vehicle template: job/subagent orchestration

Submit a long-running unit of work, get a job id back immediately, poll it
later -- the shape pi-subagents, pi-crew, pi-fabric, and their forks all
hand-roll independently. Built on Vehicle Jobs (`VehicleJobStore`) and
Monolith Mode (`createMonolithVehicle`) -- no daemon, no HTTP, no port.

## What this demonstrates

- `work.run`: the actual background-capable unit of work (`longRunning: true`
  + a declared `background` wake budget). Never called directly by a Pi tool
  call -- only `VehicleJobStore.submit()` starts it.
- `work.submit`: starts a `work.run` job and returns its `jobId` immediately.
- `work.poll`: checks a job's current status (`running`/`succeeded`/`failed`/
  `canceled`) and, once finished, its real output.

## What to rename/replace first

1. `work.run`/`work.submit`/`work.poll` → your own domain name
   (`research.run`/`research.submit`/`research.poll`, `deploy.run`/...).
2. `runWork()`'s body → your real long-running task. It currently just
   sleeps 50ms and returns a placeholder string.
3. `RunWorkInput`/its schema → your task's real input shape.
4. The Vehicle's own `name`/`description` in `createMonolithVehicle`'s first
   argument (`src/extension.ts`).

## Try it live

```bash
bun install
pi --extension ./src/extension.ts --print "submit a work job with topic 'vehicle templates', then poll it until it's done and tell me the result"
```

## When you'd want the daemon-backed Split shape instead

This template is Monolith Mode -- job state lives only as long as the Pi
session does. If jobs need to survive a session ending, or several sessions
need to share one job queue, move `registerWorkOperations()` into a real
daemon (`@danypops/vehicle-server`'s `startDaemon`/`createVehicleHttpApp`)
and swap `LocalVehicleClient` for `RemoteVehicleClient` on the Pi side --
`work.run`/`work.submit`/`work.poll` themselves don't change at all. See the
root README's "Split vs Monolith" section.
