# pi-app — what it is and why it looks like this

Team-facing explanation of the Raspberry Pi program. Operational details (install,
commands, troubleshooting) are in `README.md`; this is the "why" for whoever picks
it up.

---

## 1. What it does

The Pi is wired to **one** ESP32 (the gateway). That board prints every mesh frame
it hears as a line of JSON over USB serial. `pi-app`:

1. **reads** that serial stream (auto-detects the port, reconnects if the board is
   unplugged or reset),
2. **parses + validates** every line against the v4 protocol,
3. **keeps live state**: one record per mesh node (`origin`), de-duplicated,
4. **serves** a dashboard + a JSON/SSE API on `http://<pi-ip>:3000`.

It receives data from **all** nodes even though it is physically connected to one:
every frame carries the `origin` node id, so the store tracks each sensor
separately, whether it arrived directly or via a relay.

---

## 2. What it is NOT (scope decisions)

| Decision | Reason |
|---|---|
| **No `logicv3_secure.txt`** (the firmware HMAC layer) | v4 is what runs and it works. The HMAC/auth layer stays designed-but-not-flashed. |
| **`security.js` is not wired in** | It was written for the old v1/v3 JSON schema (`msg_id`, `orig_id`, `type`, `d1/d2`). v4 uses a different schema. Integrating it means updating its `normalize()` (or feeding it `pi-app`'s already-parsed events) + adding a dashboard panel. Deferred for time — it plugs in on top without touching ingestion. |
| **No database** | In-memory only. A crash loses history; the mesh refills state in seconds. Fine for a demo; a file/SQLite sink is a later add. |

`pi-app` runs 100% standalone. Nothing depends on a security layer that isn't
there.

---

## 3. How the pieces connect

Three **independent** links — all three are needed for the demo:

```
  ESP32 gateway  ──USB cable──►  Raspberry Pi          the DATA path
                                 reads /dev/ttyACM0    (this program)

  your laptop    ──SSH──────►    Raspberry Pi          how you start / watch it
                                 (run `npm start`)

  your laptop    ──browser──►    http://<pi-ip>:3000   how you SEE the dashboard
                 (same network)  (this program serves it)
```

SSH does **not** "carry" the dashboard. `pi-app` opens its own HTTP port on the
Pi; SSH is only to launch the process. Once it runs (or runs under `systemd`), the
browser hits the Pi's port directly over the LAN.

The ESP32s are **not** on any IP network — they use ESP-NOW between each other and
a USB cable to the Pi. Confirmed in `logicv4.txt`: no `WiFi.begin()` anywhere,
only `esp_now_*` and `Serial.*`.

---

## 4. Architecture

```
src/serial.js      opens the port, auto-detects it (Espressif VID 303a, then
                   ttyACM*/ttyUSB*), frames the byte stream into lines
                   (\r\n, partial chunks, oversized-line guard, strips ROM
                   control-byte noise), reconnects forever with backoff.
                   Emits: 'line', 'status', 'error'.

src/protocol.js    parseLine(raw) -> a normalised event, one of:
                     blank | junk | invalid | log | data
                   Strict on the fields that matter (v==4, kind, origin hex,
                   seq uint16, hops uint8) and the per-kind payload; lenient on
                   diagnostics. Non-JSON / boot noise -> junk (counted, never
                   throws). seqIsNewer() = the firmware's uint16 wraparound test.

src/store.js       one record per node, keyed by origin. Dedup by (origin, seq)
                   with wraparound + a 60 s "aged out => reboot, accept any seq".
                   Detects a definitive reboot from the STATUS payload (boots up
                   / uptime back) and rebuilds the dedup baseline immediately.
                   Alarm history (each alarm once — the firmware's 3x resend and
                   relay copies collapse). Rolling log of firmware events.
                   Node table capped (MAX_NODES) so a spoofed-origin flood can't
                   grow memory. snapshot() -> a plain JSON object.

src/api.js         node:http, no framework. GET /  /api/state  /api/stream (SSE)
                   /health. CORS open on the API so a separate frontend can read
                   it. Broadcasts a snapshot every 1 s + instantly on each alarm.

src/dashboard.js   the dashboard as one self-contained HTML string (no build, no
                   external assets). SSE live, falls back to polling.

src/simulator.js   generates synthetic v4 traffic in the exact line format the
                   firmware prints — 2 sensors + a hub, pings, status, an alarm
                   every 15-40 s. Lets us build / demo with no hardware.

src/index.js       wires serial (or simulator) -> store -> HTTP. Structured NDJSON
                   logs, graceful shutdown, prints the dashboard URLs on start.

test/              node:test unit tests (30). tools/replay.js feeds a captured
                   log through the pipeline offline. deploy/ has a systemd unit.
```

Time everywhere is the Pi's **arrival timestamp**, not the firmware's `stamped`
field (that one is coarse and resets on reboot). So "online / stale / silent"
depends only on wall-clock silence, not on how often the dashboard refreshes.

---

## 5. The v4 line format it consumes

One JSON object per line. **Data line** (a mesh reception):

```
{"v":4,"kind":K,"origin":"HEX","seq":N,"stamped":N,"epoch":N,"via":"HEX","hops":N[,"rssi":N][,<payload>]}
```

| kind | name | payload fields |
|---|---|---|
| 0 | sync | `authority` |
| 1 | ping | — |
| 2 | range | `peer`, `peerRssi` |
| 3 | alarm | `mag`, `bearing` |
| 4 | status | `fw, role, boots, up, syncAge, tx, rx, drop` |

`rssi` is omitted on a node's own local print. **Log line** (firmware event):
`{"type":"log","ev":"...","id":"HEX","t":N, ...}` — captured for the events panel.

Anything else (ROM boot noise, half a line, a baud glitch) is counted as `junk`
and ignored.

### Why the Pi dedups

The firmware prints duplicates on purpose ("the Pi owns dedup"): alarms are sent
3x, relays re-broadcast. `pi-app` collapses them by `(origin, seq)`, so each real
alarm is recorded once.

---

## 6. Running it

```bash
cd pi-app && npm install

npm run sim      # no hardware: synthetic traffic -> http://localhost:3000
npm start        # real: auto-detect the gateway port
SERIAL_PATH=/dev/ttyACM0 npm start   # force the port
npm test         # 30 unit tests
```

On the Pi, add your user to `dialout` once (`sudo usermod -aG dialout $USER`,
re-login) and run under `systemd` (`deploy/stucatch-pi.service`) so it survives
the SSH session closing and restarts on crash. Full steps in `README.md`.

The dashboard binds `0.0.0.0` by default so a laptop on the same network can open
it. That also means anyone on that network can. Nothing sensitive is on it; for a
private view use `HTTP_HOST=127.0.0.1` + `ssh -L 3000:localhost:3000 pi@<ip>`.

---

## 7. What is verified

Run on real Node (v24):

- `npm test` — 30/30 (parser: every kind, log lines, boot noise, truncated JSON,
  out-of-range fields, uint16 wraparound; store: dedup, reboot age-out, reboot via
  status, no false reboot from an out-of-order status, alarm collapse, wall-clock
  state transitions, node-table cap).
- Full HTTP end-to-end: `/`, `/api/state`, `/api/stream` (SSE), `/health`, 404,
  `OPTIONS`, CORS header.
- `serial.js` against a missing port → clean retry loop, readable error, `stop()`
  works.
- Dashboard client render path (all panels + empty states) with DOM stubs.
- Simulator → parser: 0 invalid lines.
- 20 000-line adversarial flood (garbage + truncated + random origins + bad
  kinds + valid) → memory bounded (64-node cap), no crash.
- Clean `SIGTERM` shutdown even with a live SSE client (32 ms).

**Not verified here:** an actual ESP32 plugged into a Pi. The line framer is
tested against synthetic traffic and the format matches `printReception` in
`logicv4.txt` field-by-field. On the Pi, if `npm install` can't fetch a prebuilt
`serialport` binary for the CPU, install `build-essential python3` and retry.

---

## 8. Deferred (roadmap — useful for the pitch)

Security is layered. What runs today: the mesh survives floods and malformed
frames, and the Pi rejects garbage and de-duplicates replays. What is designed /
partly built but not wired in, and why (time):

1. **HMAC frame authentication** (`logicv3_secure.txt`) — an 8-byte keyed tag so a
   device without the shared key cannot inject a fake alarm or a fake time-sync.
   ~30 lines on top of the v4 frame builder; needs the whole fleet reflashed
   together and a re-test slot.
2. **Behavioral detector on the Pi** (`security.js`, already written + tested) —
   flags coordinated bursts, rate spikes, impossible values, jamming-like
   silence, in real time. Needs a schema bridge to v4 and a dashboard panel.
3. **Persistent history** — an SQLite/NDJSON sink so a Pi restart doesn't lose the
   timeline.

All three plug into what runs now without changing the ingestion path.
