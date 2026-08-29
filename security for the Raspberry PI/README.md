# security.js

The security monitor for the Pi side. One file, no dependencies, plain JS that
runs in Deno as-is. Detection only: our firmware doesn't sign or encrypt
anything, so this spots a bad actor, it can't stop one.

## Drop-in

```js
import { createSecurityMonitor } from "./security.js";

const sec = createSecurityMonitor();

// where you already read a line off the serial socket:
sec.ingest(rawLine);          // the raw JSON string, exactly as it arrived

// on your dashboard tick (once a second is fine):
const report = sec.getReport();
```

That's the whole integration — four lines. `ingest` takes the string you already
have (a `Uint8Array`/`Buffer` off a socket works too, I decode it). `getReport`
gives you a plain object to render.

Low-risk to add:

- **No install.** Zero dependencies, one `.js` file, `import` it and go.
- **No Deno flags.** No file, network, or env access — `deno run` with nothing
  extra runs it.
- **No build.** Plain JS with JSDoc types; drop it into a `.ts` project as-is.
- **It never throws from `ingest`.** A bad line becomes a `malformed` event.
- **If you forget the `getReport` tick,** every `ingest`-driven check still
  works (unknown node, replay, rate, flood, impossible, rogue sync, malformed,
  reboot). Only silence/jamming need the tick, and they catch up the moment you
  call it.
- **Every `getReport()` returns the same shape** — all keys always present,
  arrays possibly empty. `status`, `lastRssi`, `lastHops`, `lastKind`,
  `lastSeq`, `epoch` on a node can be `null`; nothing else.

## What `getReport()` returns

```js
{
  generatedAt,                     // ms
  mode: "learning" | "watching",   // learning = still inside the 40s grace window
  hub,                             // the origin id I locked onto as the time authority, or null
  summary: {
    nodes, suspect, silent,
    threatLevel: "none" | "low" | "medium" | "high",   // from events in the last 20s
    messages, malformed, recentEvents,
  },
  nodes: [                         // worst first
    {
      id, role, known,
      state: "ok" | "warn" | "silent" | "suspect",
      flags: ["unknown_node", ...],    // whatever is live on this node right now
      msgCount, lastSeenMsAgo, lastSeq, lastKind, lastRssi, lastHops, epoch, status,
    },
  ],
  events: [                        // newest first, repeats folded into one row
    { kind, severity, node, detail, ts, lastTs, count },
  ],
}
```

For your UI: grey out or badge any node with `state === "suspect"` (I'm fairly
sure that one's hostile or broken). `"warn"` is softer. `"silent"` means it had
a heartbeat and went quiet. `events` is a running log you can just print.

## Two things that will bite you if I don't say them

1. **`getReport()` is not read-only.** It re-checks which nodes went silent and
   whether that looks like jamming, because those are clock-driven. Call it on a
   steady tick even on frames where you don't repaint. Once a second is plenty.

2. **The learn window starts on the first `ingest` and lasts 40s.** Every origin
   seen in that window is trusted. Past it, a *complete, role-valid status
   frame* still adopts a node for up to 80s from start (a dedicated relay only
   heartbeats every 30s). The gateway is always auto-trusted (its rssi-less
   self-report, or whatever mints SYNC). Anything that first appears as a bare
   ping after 40s, or any node after 80s, gets flagged `suspect` and stays that
   way. If you power boards up late, pass the real ids and skip the guessing:

   ```js
   createSecurityMonitor({ knownNodes: ["A0B0C0D0", "A1B1C1D1", "A2B2C2D2"] });
   ```

   (hex, any case).

## Tuning

Everything is in `DEFAULT_CONFIG` at the top of the file, all commented. Pass a
partial object to override. If one check gets noisy in the field, switch it off
without touching code:

```js
createSecurityMonitor({ checks: { replay: false } });
```

The knobs you're most likely to touch: `knownNodes`, `silenceMs` (20s, sensors),
`heartbeatSilenceMs` (75s, hub/relay — they only heartbeat every 30s),
`ratePerSec` (25), `jammingMinNodes` (2 — bump to 3 if a demo where you move
sensors around trips it).

## What it flags

| kind          | severity | when |
|---------------|----------|------|
| `unknown_node`| high     | an origin not seen during the learn window and not in `knownNodes` — stays flagged while it keeps transmitting |
| `replay`      | high     | an old `(origin, seq)` frame reappearing. A relayed copy (`hops >= 1`) is allowed to lag a few seq inside the resend window; a *direct* (`hops 0`) frame more than one seq behind the max has no honest reason to be, so it's flagged. Reboots and the 3x alarm resend are excused. |
| `rate_spike`  | high     | one origin sending faster than `ratePerSec` (default 25/s; normal is ~1/s) |
| `id_flood`    | high     | far more distinct origins seen than a real fleet (`maxNodes`, default 24) — someone's minting fake ids |
| `rogue_sync`  | high     | a SYNC frame from an origin that isn't the hub (only one board should mint SYNC) |
| `jamming`     | high     | two or more nodes go silent within `jammingWindowMs` of each other |
| `impossible`  | medium   | `mag`, `bearing`, `hops`, or `epoch` outside what the hardware can produce, or a status with a missing field (rssi is *not* range-checked — its scaling varies by ESP core) |
| `silent`      | medium   | a node that had a steady heartbeat went quiet past its threshold |
| `malformed`   | low      | a line I couldn't parse, or one that doesn't match its own kind |
| `node_reboot` | info     | a status frame where the boot count jumped or uptime fell, or a fresh boot log line (also suppresses a false replay right after) |
| `recovered`   | info     | a node that was silent started talking again |

## What each check is for

Detection only — no frame is signed, so each of these spots a symptom, it can't
block the sender. What each one is, how it works, and what it's watching for:

**`unknown_node`.** An `origin` id that isn't in the trusted set. The set comes
from `knownNodes` if you pass it, otherwise from every id heard in the first
40s; after that, only a complete role-valid status frame still adopts a node (up
to 80s from start), and the gateway is always trusted. Anything else that starts
transmitting is flagged, and stays flagged while it keeps talking — a radio
that isn't part of the fleet you deployed. Reusing a real id defeats this; that
gap is the HMAC layer's job, which we haven't built.

**`replay`.** An old `(origin, seq)` frame reappearing. Per node I keep the
highest `seq` and when I saw it. A relayed copy (`hops >= 1`) may lag a few seq
inside the resend window, but a direct (`hops 0`) frame more than one seq behind
the max has no honest reason to exist. The firmware's 3x alarm resend and the
seq reset after a reboot are excused. Catches a frame captured off the air and
re-injected later — a stale "all clear", an old alarm.

**`rate_spike`.** One `origin` sending far above the normal ~1/s. A per-second
counter per node fires once when it crosses `ratePerSec` (default 25). Catches a
node being flooded, or one id being spammed at speed.

**`id_flood`.** Far more distinct `origin`s than a real fleet has. A counter of
every id ever seen (evicted ones included) trips past `maxNodes` (24); the node
table itself is hard-capped, so memory stays flat regardless. Catches an
attacker minting fake sender ids to bury the real picture or exhaust the reader.

**`rogue_sync`.** A SYNC (time-authority) frame from an `origin` that isn't the
hub. The first SYNC seen defines the hub id; any later SYNC from a different id
is flagged. Catches a second device posing as the clock to skew ordering across
the mesh.

**`jamming`.** Several nodes going quiet together. On each `getReport()` I
re-derive which steady nodes are silent; `jammingMinNodes` (2) or more falling
silent within `jammingWindowMs` (8s) of each other is reported as jamming rather
than as separate `silent` alerts. Tells a broad RF outage apart from one node
dying.

**`impossible`.** A field value the hardware can't produce, or a status frame
missing one. Range checks: `mag` 0–60, `bearing` 0–360, `hops` 0–8, `epoch`
0–65535, and a status must carry every field. `rssi` is deliberately not
range-checked — its scaling varies by ESP core. Catches corrupted frames or
hand-built ones where the attacker didn't match real value ranges.

**`silent`.** A node that had a steady heartbeat stopped. It has to look steady
first (≥3 messages, seen for >8s); then the threshold is per role — sensors
`silenceMs` (20s), hub and relay `heartbeatSilenceMs` (75s), since those only
beacon every 30s. Re-derived on the tick. A dead, removed, or jammed node.

**`malformed`.** A line that won't parse, or whose body doesn't match its
declared kind. The parser try/catches everything and emits an event instead of
throwing. Surfaces a corrupt serial link or injected garbage, and keeps
`ingest` from ever crashing your reader.

**`node_reboot`.** A status frame where `boots` jumped or uptime fell, or a
fresh boot log line. Opens a short grace window so the node's seq reset right
after isn't read as a `replay`. Explains an expected event instead of alarming
on it.

**`recovered`.** A node that was `silent` is transmitting again. On the tick its
silence is cleared and this is emitted, closing out the earlier alert so the
operator knows it's back.

## `getReport()` also returns `counters`

`{ lines, data, log, malformed, impossible, replay, rateSpike, evicted }` — a
top-level object next to `summary`, for a system-health line if you want one.
`evicted` climbing means the node table hit its cap (a flood, or `maxNodes` set
below your real fleet size).

## Tests

`security.test.js` — node:test on this machine, but the module is Deno-safe. 42
cases: every check, the tricky false-positive cases (3x resend, relayed copy
several seq behind, a *direct* old-seq that must be caught, an old seq with a
bogus hop count that must still be caught, reboot from silence, reboot from a
status frame, a straggler after a reboot, out-of-order status, hub/relay 30s
heartbeat, mis-scaled rssi), a flood not evicting a known node, a broken config
not throwing, learning vs watching, `knownNodes`, config toggles, and that a
clean hub + 2 sensors + relay stream over 400s raises nothing. It also survives a
15000-line fuzz of mixed junk (incl. explicit-undefined config overrides) and never throws, with the node table and event
log staying bounded.
