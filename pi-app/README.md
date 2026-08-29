# pi-app — ESP32 mesh gateway monitor

The program that runs on the Raspberry Pi. It reads the ESP32 **gateway** board
over USB serial, parses the v4 mesh protocol, keeps live per-node state, and
serves a dashboard + JSON API. One command to run, no build step, one npm
dependency (`serialport`).

It receives data from **every** ESP in the mesh: the Pi is wired to one board
(the gateway), and that board prints every frame it hears — pings, syncs, range
replies, alarms, status — tagged with the `origin` node id. This app tracks each
`origin` separately.

## The three connections (they are independent)

```
  ESP32 gateway  ──USB cable──►  Raspberry Pi        the DATA path
                                 (/dev/ttyACM0)      this app reads it

  your laptop    ──SSH──────►    Raspberry Pi        how you DRIVE the Pi
                                 (edit files, run)

  your laptop    ──browser──►    http://<pi-ip>:3000 how you SEE the dashboard
                 (same Wi-Fi)    (this app serves it)
```

SSH is only how you log into the Pi to start/stop things. The ESP data comes in
over the USB cable, not over SSH.

## Quick start — no hardware (simulator)

On your laptop:

```bash
cd pi-app
npm install
npm run sim
```

Open <http://localhost:3000>. You'll see two synthetic sensors, a hub, pings,
status, and an alarm every 15–40 s. Good for building/among the display and for a
backup demo.

## Run on the Raspberry Pi (real hardware)

**1. Install Node (18+).** Raspberry Pi OS Bookworm:

```bash
sudo apt update && sudo apt install -y nodejs npm
node -v        # want v18 or newer
```

If apt gives you something older, use nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash` then `nvm install 20`.

**2. Let your user open the serial port** (one time, then log out/in):

```bash
sudo usermod -aG dialout $USER
```

**3. Copy the app to the Pi and install deps:**

```bash
# from your laptop:
scp -r pi-app pi@<pi-ip>:~/
# on the Pi:
cd ~/pi-app && npm install
```

**4. Find the gateway's port** (plug the ESP32 in first):

```bash
ls -l /dev/serial/by-id/     # stable name, survives replug
ls /dev/ttyACM* /dev/ttyUSB* # what it shows up as
```

**5. Run it:**

```bash
npm start                         # auto-detects the port
# or force it:
SERIAL_PATH=/dev/ttyACM0 npm start
```

On start it prints the dashboard URLs (localhost + every LAN IP). Open the LAN
one from your laptop's browser. Get the Pi's IP with `hostname -I`.

## Keep it running for the whole event

```bash
sudo cp deploy/stucatch-pi.service /etc/systemd/system/
sudoedit /etc/systemd/system/stucatch-pi.service   # fix User=, paths, env
sudo systemctl daemon-reload
sudo systemctl enable --now stucatch-pi
journalctl -u stucatch-pi -f
```

## HTTP endpoints

| route          | what |
|----------------|------|
| `GET /`        | the dashboard (single HTML page) |
| `GET /api/state`  | current snapshot as JSON |
| `GET /api/stream` | Server-Sent Events: a snapshot every second + instant push on each alarm |
| `GET /health`  | `{ ok, serial, uptimeMs }` for a liveness check |

`/api/state` shape:

```jsonc
{
  "generatedAt": 1737000000000,
  "uptimeMs": 123456,
  "serial": { "state": "open", "path": "/dev/ttyACM0", "attempts": 0 },
  "counters": { "lines": 900, "data": 780, "log": 90, "junk": 20, "invalid": 0, "dupes": 240, "alarms": 3 },
  "nodeCount": 3, "onlineCount": 3,
  "nodes": [ { "id": "A1B1C1D1", "roleName": "sensor", "state": "online",
              "lastSeenMsAgo": 1200, "lastSeq": 41234, "lastRssi": -57,
              "lastHops": 0, "syncEpoch": 40001, "status": { "...": "..." },
              "lastAlarm": null, "flags": {} } ],
  "alarms": [ { "ts": 0, "origin": "A1B1C1D1", "seq": 41234, "magnitude": 0.42,
                "bearing": 135, "hops": 0, "rssi": -60 } ],
  "events": [ { "ts": 0, "ev": "sync", "id": "A0B0C0D0", "fields": {} } ]
}
```

## What it expects on the serial line (protocol v4)

One JSON object per line. Data lines:

```
{"v":4,"kind":K,"origin":"HEX","seq":N,"stamped":N,"epoch":N,"via":"HEX","hops":N[,"rssi":N][,<payload>]}
```

`kind`: 0 sync (`authority`), 1 ping (none), 2 range (`peer`,`peerRssi`),
3 alarm (`mag`,`bearing`), 4 status (`fw,role,boots,up,syncAge,tx,rx,drop`).
`rssi` is absent on a node's own local print.

Log lines: `{"type":"log","ev":"...","id":"HEX","t":N, ...}` — captured for the
events panel.

Anything else on the line (ROM boot noise, half a line, a baud glitch) is counted
as `junk` and ignored, never crashes the reader.

### Dedup

The firmware prints duplicates on purpose ("the Pi owns dedup"): alarms are sent
3×, relays re-broadcast. This app dedups by `(origin, seq)` with uint16
wraparound handling, and after `REBOOT_AGE_MS` (60 s) of silence from a node it
accepts any seq again (a rebooted node comes back with a fresh random seq). Each
real alarm is therefore recorded once.

## Config (environment variables)

| var | default | meaning |
|-----|---------|---------|
| `SERIAL_PATH` | auto | force the serial device |
| `SERIAL_BAUD` | `115200` | |
| `HTTP_HOST` | `0.0.0.0` | set `127.0.0.1` to keep the dashboard local-only |
| `HTTP_PORT` | `3000` | |
| `SSE_INTERVAL_MS` | `1000` | dashboard refresh cadence |
| `REBOOT_AGE_MS` | `60000` | silence after which any seq from a node is accepted |
| `MAX_NODES` | `64` | hard cap on tracked nodes (bounds memory under a spoofed-origin flood) |
| `SIMULATE` | – | `1` = synthetic traffic, no serial |

`/api/state`, `/api/stream` and `/health` send `Access-Control-Allow-Origin: *`,
so a separate frontend can read the telemetry cross-origin.

**OPSEC note:** the default binds `0.0.0.0` so a laptop on the venue Wi-Fi can
open the dashboard — which means anyone on that Wi-Fi can too. There's nothing
sensitive on it, but if you want it private use `HTTP_HOST=127.0.0.1` and an SSH
tunnel: `ssh -L 3000:localhost:3000 pi@<pi-ip>`.

## Tests

```bash
npm test
```

Covers the parser (every kind, log lines, boot noise, truncated JSON,
out-of-range fields, wraparound) and the store (dedup, reboot age-out, alarm
collapse, wall-clock state transitions).

Offline check against a captured log:

```bash
npm start > capture.ndjson        # or capture the raw serial with `cat /dev/ttyACM0`
node tools/replay.js capture.ndjson
```

## Troubleshooting

| symptom | fix |
|---|---|
| `Error: Permission denied /dev/ttyACM0` | `sudo usermod -aG dialout $USER`, then log out/in |
| `Error: Resource temporarily unavailable` | another program holds the port. `sudo systemctl stop ModemManager` (or `sudo apt purge modemmanager`) |
| port keeps changing (`ttyACM0` ↔ `ttyACM1`) | use `SERIAL_PATH=/dev/serial/by-id/usb-...` |
| `npm install` tries to compile serialport | `sudo apt install -y build-essential python3` and retry; usually a prebuilt binary is fetched and this isn't needed |
| dashboard loads but says `serial: reconnecting` | wrong port, board unplugged, or firmware not printing — check `npm start` logs and `screen /dev/ttyACM0 115200` |
| `EADDRINUSE` | `HTTP_PORT=3001 npm start` |

## Files

```
src/config.js      env-driven config
src/serial.js      auto-detect + auto-reconnect serial reader, line framing
src/protocol.js    parseLine(): validate + normalise the v4 wire format
src/store.js       per-node state, dedup, alarms, events, snapshot()
src/api.js         http server: dashboard, /api/state, /api/stream (SSE)
src/dashboard.js   the dashboard as one self-contained HTML string
src/simulator.js   synthetic v4 traffic for no-hardware runs
src/index.js       wires it together
test/              node:test unit tests
tools/replay.js    feed a captured log through the pipeline offline
deploy/            systemd unit
```
