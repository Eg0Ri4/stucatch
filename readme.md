# stucatch firmware

A wireless mesh for early detection and direction-finding of mechanical vibrations and
impacts. ESP32 boards with ADXL345 accelerometers broadcast over ESP-NOW (no router, no
WiFi network); a hub prints everything it hears as NDJSON over USB serial for the Pi
pipeline to ingest.

Firmware: `logic` · protocol **v4** · one source file, role selected at flash time.

## Hardware & roles

| role | board | job |
|---|---|---|
| `ROLE_HUB` (0) | ESP32-S3 | sole time authority (mints SYNC) |
| `ROLE_SENSOR` (1) | ESP32-C3 super mini + ADXL345 (I²C on GPIO 8/9) | detects impacts ≥ 0.20 g, pings, answers pings with range measurements |
| `ROLE_RELAY` (2) | ESP32 | re-broadcasts what it hears (hop+1, up to `MAX_HOPS` = 2) |

```
sensor ──┐
sensor ──┼── broadcast (ESP-NOW, channel 6, unencrypted) ──> relay ──> hub ══ USB serial ══> Pi
sensor ──┘         every packet reaches every board in range; roles decide what to do with it
```

All boards run the same file. Set `#define MY_ROLE` before flashing each board.
**v4 and v3 cannot coexist on air** (v4 drops on the version byte, v3 drops on length) —
when upgrading, flash all boards in one sitting.

## Protocol v4

### Frame = header + per-kind payload

Variable length. A field exists only if the kind defines it — there are no unused
"ghost" fields on the wire.

```
header (19 B, little-endian, packed — every frame):
  version    u8     protocol version, 4. receivers drop anything else
  kind       u8     see message kinds below
  origin     u32    node id (from the STA MAC) — who uttered this
  seq        u16    per-node monotonic counter. identity = (origin, seq).
                    seeded randomly at boot, never 0
  forwarder  u32    last radio hop (== origin when direct)
  hops       u8     0 = direct; relays forward while hops < 2
  stamped    u32    sender's synced clock, ms (the hub's raw clock — it IS the authority)
  epoch      u16    seq of the SYNC frame this sender's clock derives from. 0 = never synced

payload sizes: SYNC 4 · PING 0 · RANGE 5 · ALARM 8 · STATUS 22
frame sizes:   SYNC 23 · PING 19 · RANGE 24 · ALARM 27 · STATUS 41   (ESP-NOW max 250)
```

### Protocol rules

- **Identity is `(origin, seq)`.** Receivers keep a per-origin last-seen table
  (16 slots, entries age out after 60 s so a rebooted node is re-accepted).
  Sequence gaps on the Pi = per-link loss rate, for free.
- **The hub is the only time authority.** It broadcasts SYNC every 10 s; every other
  board sets `offset = millis − authority` and adopts the SYNC's `seq` as its `epoch`.
  Relays forward SYNC but never mint their own — there is exactly one clock base.
- **Alarms are re-broadcast blind**: 2 repeats (+200 ms, then +800 ms apart) with the
  **same seq and original stamped time**. A repeat is just another reception of the same
  utterance; relays suppress repeats they already forwarded, and forward a repeat whose
  first copy they never heard.
- **Nobody dedups the serial stream.** Every board prints every reception as a
  `{"v":4,...}` line, duplicates included — whichever board sits on the USB port is a
  full gateway. A relayed copy carries its own path data (`via`, `hops`, `rssi`);
  duplicate suppression is the Pi's job.

## Message kinds

| kind | name | who | when | payload |
|---|---|---|---|---|
| 0 | SYNC | hub only | every 10 s | `authority` u32 — hub clock, ms |
| 1 | PING | sensors | every 5 s | — |
| 2 | RANGE | sensors | on hearing a *direct* PING | `peer` u32, `rssi` i8 — "I heard `peer`'s ping this loud" |
| 3 | ALARM | sensors | vibration ≥ 0.20 g (then 200 ms cooldown) | `magnitude` f32 (g), `bearing` f32 (degrees, **sensor's own frame**) |
| 4 | STATUS | all | every 30 s | `fw` u8, `role` u8, `bootCount` u16, `uptimeS` u32, `syncAgeS` u16, `tx` u32, `rx` u32, `drop` u32 |

As the hub prints them (one NDJSON line per reception):

```json
{"v":4,"kind":0,"origin":"A1B2C3D4","seq":312,"stamped":50000,"epoch":311,"via":"A1B2C3D4","hops":0,"rssi":-58,"authority":50000}
{"v":4,"kind":1,"origin":"9B05FEF8","seq":1841,"stamped":49980,"epoch":312,"via":"9B05FEF8","hops":0,"rssi":-67}
{"v":4,"kind":2,"origin":"7A31D2F4","seq":902,"stamped":49982,"epoch":312,"via":"7A31D2F4","hops":0,"rssi":-74,"peer":"9B05FEF8","peerRssi":-71}
{"v":4,"kind":3,"origin":"9B05FEF8","seq":1842,"stamped":50109,"epoch":312,"via":"C4E19A08","hops":1,"rssi":-58,"mag":0.42,"bearing":135.0}
{"v":4,"kind":4,"origin":"9B05FEF8","seq":1843,"stamped":50210,"epoch":312,"via":"9B05FEF8","hops":0,"rssi":-66,"fw":4,"role":1,"boots":7,"up":320,"syncAge":10,"tx":75,"rx":12,"drop":0}
```

Reading the fields honestly:

- `rssi` (top level) is stamped **by the printing board at reception** — it measures the
  *last hop → printing board* link, never the sender's world. On the hub's own STATUS
  line it is omitted entirely (no radio hop happened).
- `peerRssi` inside a RANGE is the one node-to-node measurement that travels as data:
  the loudness of `peer`'s ping *at the replying sensor*. RANGE replies fire only on
  direct pings (`hops == 0`), so `peer` and `peerRssi` always describe the same edge.
- `bearing` is the impact direction in the sensor's own mounting frame. The firmware is
  deliberately dumb about orientation — per-node mounting offsets live on the Pi.
- The kind-3 line above shows a relayed copy: `via` ≠ `origin`, `hops:1`. The same
  utterance may also arrive direct — same `(origin, seq)`, different path fields.
- `syncAge` 0xFFFF (65535) means never synced; the value clamps at 65534.

## Runtime model

### Boot (`setup`)

```
Serial 115200
NVS: bootCount++
radio: persistent(false) → STA mode → disconnect(erase creds)
       → pin channel 6 → power-save off → read MAC via esp_read_mac (radio-independent)
LOG boot        {fw, protocol, role, boots, channel, dev}
esp_now_init    → register recv + send callbacks → add broadcast peer
tx power 8.5 dBm (set AFTER the radio is provably up; C3 super mini antenna quirk)
LOG espnow_ready {txPower}   ← read back, self-verifying
sensors: ADXL345 init + baseline calibration (100 samples, divides by good reads)
LOG ready
```

### Receive path — callback does nothing, loop does everything

```
OnDataRecv (WiFi task):  size + version check → copy into 16-slot ring → return
                         (no Serial, no radio TX, no logic in the callback)
loop() drainRx():        shape check (len == header + payload for kind)
                         → witness(origin, seq) → NEW | DUPE | RESEND
                         → print reception line (every role, always, even DUPE)
                         → non-hub + SYNC: adopt offset + epoch, LOG sync with delta
                         → relay + not DUPE + hops < 2: forward with forwarder=me, hops+1
                         → sensor + direct PING + NEW: reply RANGE (jittered ≤20 ms)
```

### Timers (all in `loop`, non-blocking except the 200 ms alarm cooldown)

| every | who | action |
|---|---|---|
| 10 s | hub | broadcast SYNC |
| 5 s | sensors | broadcast PING |
| 30 s | all | broadcast STATUS (hub also prints its own) |
| 10 s | all, `DEV` only | LOG status + baseline |
| ~10 ms | sensors | read ADXL, compare against drifting baseline (EMA 0.995), fire ALARM on ≥ 0.20 g |
| pending | sensors | re-broadcast buffered alarm frames (same seq) |

### Serial contract

Every line is JSON. Two grammars on one port:

- **data lines** — `"v":4` — receptions, the Pi's ingest stream
- **log lines** — `"type":"log"` — state transitions and events:
  `boot · espnow_ready · espnow_init_failed · peer_add_failed · ready · calibrating ·
  calibrated · sync · alarm · range · send_error · i2c_lost · i2c_recovered ·
  rx_overflow · rx_drop · status · baseline` — plus per-packet `tx · tx_result · rx · drop`
  traces when `DEV` is 1. `DEV 0` compiles the traces out entirely.

## Flashing

```bash
# per board: set MY_ROLE in logic, then
arduino-cli compile --fqbn esp32:esp32:esp32c3 <sketch dir>    # sensors / C3 relay
arduino-cli compile --fqbn esp32:esp32:esp32s3 <sketch dir>    # hub
arduino-cli upload -p /dev/cu.usbmodem* --fqbn <fqbn> <sketch dir>
```

The sketch dir must be named after the `.ino` (e.g. `stucatch/stucatch.ino` containing
`logic`'s content). All boards share `WIFI_CHANNEL 6` — change it in one place or not at all.

First 5 seconds of serial after flashing verify the build: `boot` shows the real node id
(not `"0"`), `espnow_ready` shows the read-back tx power.
