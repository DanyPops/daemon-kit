# Vehicle template: remote/chat-bridge daemon

One operation reachable both as a Pi tool (`chat.send`, over the Vehicle wire
protocol) and over a second inbound webhook route (`/webhook`) -- the shape
@llblab/pi-telegram, pi-intercom, @gamalan/pi-gateway, and others all
hand-roll independently. This is the **Split** deployment shape (a real
daemon process), not Monolith -- a chat bridge must keep running and
receiving webhooks whether or not any particular Pi session is open. See the
root README's "Split vs Monolith" section.

## What this demonstrates

- `chat.send`: an `external-write`-effect Vehicle operation any Pi extension
  can call as a normal tool.
- `chat.history`: a `read`-effect operation listing everything sent/received
  so far.
- `chat.message.received`: a declared Vehicle Event, emitted whenever the
  `/webhook` route receives an inbound message -- observable in-process via
  `registry.subscribeLocal()`, or remotely via `RemoteVehicleClient.subscribe()`
  once you bridge it onto a `PushChannel` (see the root README's Vehicle
  Events section).
- `/webhook`: a plain, non-Vehicle HTTP route sharing the exact same process
  and port as the Vehicle wire protocol -- proof one daemon can genuinely
  serve both transports.

## What to rename/replace first

1. `chat.send`'s handler body → your real chat platform's SDK call
   (Telegram/Discord/Slack/...), replacing the in-memory `state.sent` log.
2. `/webhook`'s body parsing → your real platform's actual webhook payload
   shape, plus real signature verification before trusting it.
3. `CHAT_BRIDGE_TOKEN`'s hardcoded dev default → a real generated secret (see
   `@danypops/vehicle-server/vault` for this house's own credential storage).

## Try it live

```bash
bun install
bun run daemon &                 # starts the daemon on :8787
curl -X POST localhost:8787/webhook -H 'content-type: application/json' \
  -d '{"from":"alice","text":"hello"}'
pi --extension ./src/extension.ts --print "send a chat message to #general saying hello, then show me the chat history"
```

## When you'd want Monolith Mode instead

You wouldn't, for this shape specifically -- a chat bridge's whole point is
staying up and receiving webhooks independent of any one Pi session, which is
exactly what Monolith Mode (one process per session, gone when the session
ends) can't do. See the job-orchestration and memory templates for two
shapes where Monolith genuinely is the better first choice.
