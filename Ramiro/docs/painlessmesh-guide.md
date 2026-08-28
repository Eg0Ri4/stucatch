# painlessMesh — complete guide for the UGS Mesh

Decision from the team talk: the mesh layer is **painlessMesh**. Firmware code is
in `firmware/`. This doc is the full picture — how it works, how to set it up, the
two sketches explained, how to flash and test, and what software help is available
right now without any hardware.

---

## 1. What painlessMesh is

A self-forming, self-healing wireless mesh for ESP32 / ESP8266, over **2.4 GHz
WiFi** (each board runs as AP + station at once — no router needed).

- Every node with the same **prefix (SSID)**, **password**, **port** and
  **channel** joins one mesh automatically.
- **Multi-hop is automatic**: if node A can't reach the root directly, another
  node relays. If a node dies, traffic reroutes.
- You send a `String` (we send a JSON line). Every node's receive callback fires.
- Built on **TaskScheduler** (cooperative multitasking — never use `delay()`),
  **ArduinoJson**, and **AsyncTCP** (ESP32).
- Nodes share a synced clock (`mesh.getNodeTime()`), useful later.

Our topology: **2 sensor nodes + 1 root node**. The root is an ordinary mesh node
that also happens to be wired to the Raspberry Pi over USB; its job is to print
every frame it receives to Serial.

```
[sensor N01] --\
                >-- (mesh, auto multi-hop) --> [root] --USB serial--> [Raspberry Pi]
[sensor N02] --/                                                        |
                                                        app/serial_bridge.py --> gateway /ingest
```

---

## 2. Dependencies & setup

### Option A — PlatformIO (recommended, versions pinned)

`firmware/platformio.ini` is ready. From `firmware/`:

```bash
pio run -e sensor_node -t upload      # flash a sensor node (edit NODE_ID first)
pio run -e root_node   -t upload      # flash the root
pio device monitor -b 115200          # watch Serial
```

Pinned libraries: `painlessMesh ^1.5.6`, `ArduinoJson ^7.2`, `TaskScheduler ^3.8`.
`AsyncTCP` comes transitively; if the build or the mesh misbehaves on the C3, pin
a maintained fork (`mathieucarbou/AsyncTCP`) — line already in the file, commented.

### Option B — Arduino IDE

1. Boards Manager → install **esp32 by Espressif**.
2. Library Manager → install **painlessMesh**, **ArduinoJson** (v7), **TaskScheduler**.
   (painlessMesh pulls `AsyncTCP`; if Library Manager doesn't, add it manually.)
3. Open `firmware/sensor_node/sensor_node.ino`.
4. Board: **LOLIN C3 Mini** (or **ESP32C3 Dev Module**). Port: the `/dev/ttyACM*`
   or `/dev/ttyUSB*` that appears when the board is plugged in.

### Kali VM note

To flash from inside the VM the USB device must be passed through
(VirtualBox: *Devices → USB*; VMware: the connect prompt). Then
`ls /dev/ttyACM* /dev/ttyUSB*` should show it, and you need to be in the
`dialout` group (`sudo usermod -aG dialout $USER`, then re-login). Flashing from
the host OS is also fine.

---

## 3. The message contract (must match the gateway)

The sensor node broadcasts exactly this (compact, one line):

```json
{"node_id":"N01","seq":12,"modality":"pir","detection":{"class":"person","confidence":0.7}}
```

Validated by `app/models.py::NodeMessage`. Rules:

| field | rule |
|---|---|
| `node_id` | string, must exist in `config/nodes.json` (that's where its lat/lon lives) |
| `seq` | integer, **strictly increasing per node**, survives reboot (persisted to NVS). Stale/duplicate `seq` is rejected by the gateway. |
| `modality` | one of `acoustic seismic pir magnetometer rf camera` |
| `detection.class` | one of `drone person vehicle unknown clear` (`clear` = keepalive) |
| `detection.confidence` | float 0.0–1.0 |

The gateway adds `ts` (arrival time) and `lat`/`lon` (from the registry) — the
node does **not** send those (it has no clock and no GPS; kickoff Q9/Q13).

### node_id mapping

Each node gets its identity at flash time: `#define NODE_ID "N01"` in the sketch.
painlessMesh's own numeric `mesh.getNodeId()` is **not** used as the id — we keep
human ids that match `config/nodes.json`. Flash N01 with `"N01"`, N02 with
`"N02"`, etc.

---

## 4. The sensor node sketch (`firmware/sensor_node/sensor_node.ino`)

What it does:

1. **Boot**: open NVS, load the `seq` high-water mark, resume the counter *ahead*
   of anything used before the reboot → a `seq` is never reused.
2. **Join the mesh**: `mesh.init(prefix, password, scheduler, port, WIFI_AP_STA, channel)`
   then `mesh.setContainsRoot(true)`.
3. **Keepalive task**: every `KEEPALIVE_MS` send `class:"clear"` so the Pi knows
   the node is alive (needed later for jamming/dropout detection).
4. **Loop**: `mesh.update()` every iteration (mandatory), then read the sensor;
   on a debounced event call `sendData()`.
5. **`sendData()`** builds the JSON with `nextSeq()` and `mesh.sendBroadcast()` —
   this is the function the hardware team asked for.

Edit per node: `NODE_ID`, `MODALITY`, `SENSOR_PIN`. Replace the `digitalRead`
block in `loop()` with the real sensor read / classifier — everything else stays.

Key correctness points already handled:
- `serializeJson` writes to a `String` lvalue before `sendBroadcast` (the API
  needs an lvalue).
- `nextSeq()` burst-persists (1 NVS write per 1000 messages) — flash endurance.
- No `delay()` anywhere; the keepalive is a `Task`.

---

## 5. The root node sketch (`firmware/root_node/root_node.ino`)

Minimal by design:

1. Join the **same** mesh (same prefix/password/port/channel).
2. `mesh.setRoot(true)` + `mesh.setContainsRoot(true)` → painlessMesh optimises
   routing toward this node.
3. `mesh.onReceive(onRx)` → `onRx` does `Serial.println(msg)`. `msg` is already
   the sensor node's JSON string, so the Pi gets clean newline-delimited JSON.

A commented-out `onMeshChange()` can emit a `{"_mesh":...}` topology line for the
future security layer — left off in v0 so the bridge only ever sees valid
`NodeMessage` JSON.

---

## 6. Flash & test procedure (hardware team)

1. **Root alone**: flash `root_node`, open Serial Monitor @ 115200. Expect
   painlessMesh STARTUP lines, then silence (no senders yet).
2. **One sensor node**: set `NODE_ID "N01"`, flash `sensor_node`. Within a few
   seconds the root's Serial should print `{"node_id":"N01","seq":1,...,"class":"clear"...}`
   every ~5 s.
3. **Trigger an event**: pull `SENSOR_PIN` HIGH (or press the wired sensor). The
   root prints a `"class":"person"` line.
4. **Second sensor node**: `NODE_ID "N02"`, flash, confirm both nodes' lines
   arrive.
5. **Multi-hop check**: walk N02 out of the root's range but within N01's range —
   its lines should still arrive, relayed by N01.
6. **Hand to the Pi**: close the Serial Monitor (only one program can hold the
   port), then on the Pi:
   ```bash
   uv run python -m app.serial_bridge --port /dev/ttyACM0 --gateway http://127.0.0.1:8000
   ```

---

## 7. Gotchas

| Problem | Fix |
|---|---|
| Build fails on `AsyncTCP` for the C3 | pin `mathieucarbou/AsyncTCP` (line in `platformio.ini`) |
| ArduinoJson compile errors | painlessMesh ≥ 1.5.3 needs ArduinoJson 7; don't mix with a v6 install |
| Nodes don't see each other | prefix / password / port / **channel** must be identical on all; password ≥ 8 chars |
| Mesh unstable at the venue | 2.4 GHz is crowded — the fixed `MESH_CHANNEL` helps; try channels 1/6/11, pick the quietest |
| Can't flash the root | the serial bridge (or Serial Monitor) is holding the port — stop it first |
| Board resets / `Brownout detector` | cheap USB port — use a powered hub |
| `delay()` added somewhere → mesh drops | never `delay()`; use a `Task` |
| `sendBroadcast` won't compile | pass a `String` variable, not a temporary |
| seq resets to 1 after reboot | NVS not persisted — the sketch's `nextSeq()` handles this; don't bypass it |

---

## 8. Can we help at software level now? — Yes

Already done, no hardware needed:

1. **Both sketches written** (`firmware/`) against the locked contract. Yurii
   flashes and tests; we iterate the code.
2. **`app/serial_bridge.py` now has a `--stdin` mode** — feed it the exact lines
   the root will print and watch them flow through the gateway:
   ```bash
   printf '%s\n' \
     '{"node_id":"N02","seq":1,"modality":"acoustic","detection":{"class":"drone","confidence":0.88}}' \
     '{"node_id":"N02","seq":2,"modality":"seismic","detection":{"class":"drone","confidence":0.79}}' \
     | uv run python -m app.serial_bridge --stdin
   ```
   Verified live: 3 frames → gateway → a high-priority drone alert. Non-JSON
   mesh-status lines are skipped; stale `seq` is rejected; the bridge never dies.
3. **Contract is frozen** in `app/models.py`; the sketch JSON matches it
   field-for-field. If the team changes a field, it changes in that one file and
   the sketch together.
4. **Tests** cover the bridge with realistic sketch output
   (`tests/test_serial_bridge.py`).

Nothing blocks the hardware team: they can flash `firmware/` as-is and iterate on
the sensor read while the Pi side is already proven end to end.

---

## Sources

- [painlessMesh — GitLab (canonical)](https://gitlab.com/painlessMesh/painlessMesh)
- [painlessMesh tags / releases](https://gitlab.com/painlessMesh/painlessMesh/-/tags)
- [painlessMesh mirror + README (GitHub)](https://github.com/gmag11/painlessMesh)
- [Random Nerd Tutorials — painlessMesh getting started](https://randomnerdtutorials.com/esp-mesh-esp32-esp8266-painlessmesh/)
- [PlatformIO registry — painlessMesh](https://registry.platformio.org/libraries/painlessmesh/painlessMesh)
