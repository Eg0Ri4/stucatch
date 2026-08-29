# `security.js` — the security layer for the Pi side

Luca — this is the security module I put together so you can plug it into your
pipeline. It watches the message stream coming off the relay and flags anything
that looks like an attack: an unknown node, a replayed packet, a flood, garbage
values, or the mesh being jammed.

It's plain JavaScript, no dependencies, and it doesn't touch your code — you call
it, it hands you back a report. No serial, no HTTP, no timers of its own.

## How you use it

```js
import { createSecurityMonitor } from "./security.js";

const sec = createSecurityMonitor({
  knownNodes: ["9B05C4C0", "..."],   // the real node ids; leave empty and it learns
});

// in the handler where you already parse a serial line:
sec.ingest(msg);

// on your display refresh — call it as often or as rarely as you want:
const report = sec.getReport();
```

Both `ingest` and `getReport` optionally take a timestamp in ms; leave it out and
they use `Date.now()`. One thing that matters: **send me every message, including
the `type 0` sync and `type 1` ping**. Those are how I know a node is still alive —
if you filter them out before calling `ingest`, silence and jamming detection stop
working.

## What I expect as input

The relay's JSON, exactly as the firmware prints it:

```json
{"msg_id":123,"orig_id":"9B05C4C0","fwd_id":"9B05C4C0","type":3,"time":45231,"hops":0,"d1":0.42,"d2":135.0,"rssi":-67}
```

`type` is 0 = sync, 1 = ping, 2 = distance-map, 3 = alarm. For an alarm, `d1` is
the vibration magnitude in g and `d2` is the bearing in degrees. If you reshape
the object before passing it to me, `normalize()` in the file accepts a few
alternate key names — check that function. One caveat: whatever string form
`orig_id` has when you call `ingest`, my `knownNodes` config has to match it
exactly.

## What `getReport()` gives you

```js
{
  generatedAt,
  summary: {
    mode: "learning" | "enforcing",
    uptimeMs, messages, malformed,
    nodes, knownNodes,
    blocked,          // how many nodes are in state "blocked" right now
    threatLevel: "none" | "low" | "medium" | "high",   // only counts events from the last ~20s
    eventCount,
  },
  nodes: [
    {
      id, known,
      state: "ok" | "stale" | "silent" | "suspect" | "blocked",
      flags: ["unknown_node", ...],   // whatever is currently active on this node
      msgCount, ratePerSec, lastSeenMsAgo,
      lastType, lastMag, lastBearing, lastRssi, lastHops,
    },
  ],
  events: [ { kind, severity, nodeId, detail, ts, lastTs, count } ],
}
```

For the display: grey out or drop any node whose `state` is `"blocked"` — that's a
node I'm confident is hostile or broken. `"suspect"` is a softer warning (show it
but mark it). The `nodes` array comes back sorted worst-first. `events` is a
running log; repeats of the same thing collapse into one row with a `count`, so a
flood gives you one line, not thousands.

There's deliberately **no trust score to tune**. A node's `state` is just a
function of which flags are live on it: a serious flag (`unknown_node`, `replay`,
`rate_spike`) makes it `blocked`; a softer one (`impossible_value`, `malformed`)
makes it `suspect`; otherwise it's `silent` / `stale` / `ok` depending on how long
since I last heard from it. A flag stays live for 8 seconds after the last time it
was triggered, then the node goes back to `ok`.

## What it flags

| event | severity | when |
|---|---|---|
| `unknown_node` | high | an `orig_id` that isn't in the known set (once the learn window has closed) |
| `replay` | high | a `msg_id` I've already seen from that node, at the same or lower hop count, after a real time gap — a relayed copy or a near-instant echo doesn't count |
| `rate_spike` | high | a node sending faster than the threshold (default 20/s; normal is ~5/s) |
| `id_flood` | high | more distinct node ids than `maxNodes` — nobody specific to blame, so it's a system event |
| `impossible_value` | medium | `type` / `d1` / `d2` / `rssi` / `hops` outside a physically possible range |
| `malformed` | low | a line I couldn't parse, or `hops`/`fwd_id` that don't agree |
| `suspicious_silence` | medium | a node that had a steady heartbeat went quiet past `silenceMs` |
| `jamming_suspected` | high | two or more nodes went silent within `jammingWindowMs` of each other; re-fires as more drop |
| `clock_reset` | info | a node's synced `time` jumped backwards hard (reboot, or re-sync to a rebooted hub); I clear its replay history so it doesn't cause a false replay |
| `node_recovered` | info | a node that was silent started talking again |
| `node_learned` | info | in learning mode, an id got adopted into the known set |
| `learning_complete` | info / medium | the learn window closed (medium if nothing got established — that means you should set `knownNodes`) |

## Config

Everything is in `DEFAULT_CONFIG` at the top of the file; pass overrides to
`createSecurityMonitor`. The ones you'll actually touch:

- `knownNodes` — the real node ids. **Set this once you have them.** If it's empty
  I run in learning mode: I adopt any id that sends at least 2 messages inside the
  first 20 seconds, then flag anything new. Learning mode trusts whatever it hears
  first, so it's a fallback — the explicit list is the real answer. `summary.mode`
  tells you which one is active.
- `rateThresholdPerSec` (20), `silenceMs` (20000), `jammingWindowMs` (8000),
  `jammingMinNodes` (2).
- `plausible` — the min/max ranges for magnitude, bearing, rssi, hops, and the
  allowed `type` list. The `types` list has to match whatever the firmware sends.

All of these are first guesses. We should tune them against a few minutes of real
relay traffic once we can capture some — record it and replay it through `ingest`.

## What it doesn't do

It only detects — it doesn't block anything. Two attacks are out of reach here
because they'd need a signature on the packet at the firmware level: a forged
packet that copies a real node's id and keeps every value in a normal range, and a
replay that's re-sent with a fresh `msg_id`. Everything else — rogue ids, floods,
aged replays, jamming, garbage payloads, reboots — is covered.

## Tests

```
deno test
```

33 cases in `security.test.js` — every check, plus the tricky false-positive
cases (a relayed copy, a mesh echo, a clock reset, `rssi: 0`, a startup burst that
looks like silence), learning-mode safety, that behaviour doesn't depend on how
often you call `getReport`, and that it stays bounded under a flood.

## What I need from you

- Confirm the object shape your pipeline hands to `ingest` — I assumed the raw
  relay JSON. If you reshape it, I'll adjust `normalize()`.
- The real node ids so I can fill in `knownNodes`.
