# Firmware analysis — `logic.txt` (ESP-NOW mesh)

Review of the current node/relay/hub firmware, the defects found, how to fix each,
and an optional security layer with a realistic view of its cost and risk. This is
meant to guide a clean re-implementation of the base code — it is analysis and
design guidance, not a full listing.

Scope: `logic.txt` as reviewed (ESP32-C3 sensor nodes with ADXL345, ESP-NOW
broadcast, single-relay forwarding, hub prints JSON over serial).

---

## 1. Executive summary

The transport logic has three defects that individually can produce
"the mesh doesn't work", plus several that make it flaky or lossy under any load
beyond one sensor talking to one hub.

Ranked by likelihood of being the current cause:

1. **The WiFi channel is never pinned.** `peerInfo.channel = 0` plus no
   `esp_wifi_set_channel()` and no clearing of stored WiFi state. Boards can end up
   on different channels and never hear each other. Matches "worked yesterday, not
   today" exactly.
2. **`last_msg_id` deduplication is a single variable.** It only remembers the last
   `msg_id` from any node. With a relay in the path, or two or more sensors
   interleaving, this both duplicates packets and silently drops good ones.
3. **Two-hop relaying cannot work by design.** A relay only forwards packets whose
   `hop_count == 0`, so `sensor → relay → relay → hub` fails at the second relay.

Beyond those: a shared global packet buffer written from two execution contexts (a
race), `esp_now_send()` and a `delay()` called from inside the receive callback,
a `msg_id` generator that collides across boards, no visibility into transmit or
init failures, and a baseline-calibration routine that silently produces a wrong
baseline if any I²C read fails.

Recommendation: rewrite the **structure** (channel discipline, dedup, concurrency,
error handling) but keep the parts already proven against the hardware (the ADXL345
init sequence and pin map, the `atan2` direction math, the exponential-moving-average
baseline).

---

## 2. What the current firmware does (reference for the rewrite)

**Roles**, chosen at compile time via `MY_ROLE`:

| role | behaviour |
|---|---|
| `ROLE_SENSOR` | reads the ADXL345, sends a `ping` (type 1) every 5 s, sends an `alarm` (type 3) when vibration magnitude ≥ `VIBRATION_THRESHOLD`, adapts its baseline when below threshold, replies to other nodes' pings with a type-2 packet |
| `ROLE_RELAY` | receives packets, increments `hop_count`, re-broadcasts those with `hop_count == 0`; also prints every received packet as JSON to serial; also emits the type-0 time-sync beacon |
| `ROLE_HUB` | prints every received packet as JSON to serial; emits the type-0 time-sync beacon |

**Packet** (`MeshPacket`, `__attribute__((packed))`, 32 bytes):
`msg_id`, `original_id`, `forwarder_id`, `datatype`, `timestamp`, `hop_count`,
`data_1`, `data_2`.

**Datatypes:** 0 = time-sync beacon (hub/relay, every 10 s), 1 = sensor ping
(every 5 s), 2 = ping reply ("distance map", carries rssi + a hardcoded direction),
3 = vibration alarm (`data_1` = magnitude in g, `data_2` = bearing 0–360° from
`atan2` of the accelerometer axes, in the sensor's own frame).

**Serial output** (hub/relay only), one JSON object per received packet:
`{"msg_id","orig_id","fwd_id","type","time","hops","d1","d2","rssi"}`.

**Time sync:** one-way. The hub/relay broadcasts `millis()` in a type-0 packet
every 10 s; a sensor sets `sync_offset = millis() - received_timestamp`. Accuracy is
roughly the beacon interval; it drifts between beacons.

**Identity:** `my_id = (mac[2]<<24) | (mac[3]<<16) | (mac[4]<<8) | mac[5]`.

---

## 3. Defects

Severity: **S1** breaks the mesh, **S2** makes it flaky/lossy, **S3** latent or
design-level.

### S1-1 — WiFi channel is not pinned

`peerInfo.channel = 0` (use current channel) and nothing ever calls
`esp_wifi_set_channel()`. With `WiFi.mode(WIFI_STA)` and no `WiFi.begin()`, the
station channel is whatever the driver defaults to or whatever a previous sketch
left in NVS. If two boards land on different channels they cannot exchange ESP-NOW
frames at all.

Compounding: if a board has WiFi credentials stored in NVS from any earlier sketch,
`WiFi.mode(WIFI_STA)` can start a background reconnect. While the station scans and
associates, the radio hops channels and ESP-NOW frames are lost intermittently.

**Failure scenario:** yesterday all boards happened to boot on channel 1; today one
board restored channel 6 from stored WiFi config → silent, total mesh failure.

**Fix (every board):**

- `WiFi.persistent(false); WiFi.mode(WIFI_STA); WiFi.disconnect(true, true);`
  then a short delay, before `esp_now_init()`.
- Disable WiFi power save: `esp_wifi_set_ps(WIFI_PS_NONE)` (or `WiFi.setSleep(false)`).
- `esp_wifi_set_channel(CH, WIFI_SECOND_CHAN_NONE)` with a fixed `CH` (e.g. 1, 6 or
  11) after the station is started, and set `peerInfo.channel = CH` — not 0.
- Never call `WiFi.begin()` and never start an AP on these boards.
- Print the active channel at boot (`esp_wifi_get_channel`) so a mismatch is visible.

### S1-2 — Single-slot deduplication (`last_msg_id`)

```
if (recvData.msg_id == last_msg_id) return;
last_msg_id = recvData.msg_id;
```

One `uint32_t` remembers only the most recent `msg_id` from **any** source.

**Failure scenarios:**

- *Duplicate telemetry:* hub hears sensor A directly (id X) → `last_msg_id = X`;
  hub hears sensor B (id Y) → `last_msg_id = Y`; the relayed copy of A's packet
  (still id X, `hop_count = 1`) arrives → `X != Y` → the hub prints A's packet a
  second time.
- *Silent loss:* with two or more sensors and a relay interleaving, a genuine new
  packet can arrive right after a copy with the same id and be dropped.

The intent (dedup by id) is right; the implementation cannot work past one sensor
and one hub with no relay.

**Fix:** keep a small set of recently seen identifiers — a ring buffer of the last
~32 `(original_id, seq)` pairs, or a short per-node `last_seq` table (there are only
a handful of nodes). Check it before processing *and* before relaying. This also
makes hop loops harmless, so the `hop_count == 0` restriction (S1-3) can be relaxed.

### S1-3 — Two-hop paths do not forward

The relay condition is `datatype != 0 && hop_count == 0`, and it does
`hop_count += 1` before re-broadcasting. A packet that already passed through one
relay arrives at the next relay with `hop_count == 1` and is not forwarded.

**Failure scenario:** `sensor → relay1 → relay2 → hub` — relay2 drops it; the hub
never sees it. Any topology needing more than one relay hop is broken.

**Fix:** define `MAX_HOPS` (e.g. 3) and forward while `hop_count < MAX_HOPS`, with
the set-based dedup from S1-2 preventing loops and storms.

### S2-1 — `esp_now_init()` failure is silent

`if (esp_now_init() != ESP_OK) return;` ends `setup()` with no message. The board
then runs `loop()` but has no receive callback and every `esp_now_send()` fails.
Serial shows the boot banner, so the board looks alive while being deaf and mute.

**Fix:** log the failure and, ideally, retry or reboot. Also register a send
callback (`esp_now_register_send_cb`) and log `status != ESP_NOW_SEND_SUCCESS`.
Check the return value of `esp_now_send()` (it fails with `ESP_ERR_ESPNOW_NO_MEM`
when the internal queue — about six slots — is full under load).

### S2-2 — Global packet buffer written from two contexts (race)

`MeshPacket myData;` is a single global. It is filled and sent from `loop()` (ping,
alarm, sync) **and** from inside `OnDataRecv()` (the type-2 reply). `OnDataRecv`
runs in the WiFi task, which can preempt `loop()`.

**Failure scenario:** `loop()` is half-way through populating `myData` for an alarm
when `OnDataRecv` fires, overwrites `myData` with a type-2 reply, and calls
`sendPacket()`. `loop()` then also calls `sendPacket()`. One or both frames carry
mixed fields (alarm magnitude with a type-2 header, or vice versa). Intermittent,
load-dependent, hard to reproduce.

**Fix:** never share a packet buffer. Each site that builds a packet uses a local
`MeshPacket`. A `buildPacket()` / `sendPacket(const MeshPacket&)` pair makes this
natural.

### S2-3 — `esp_now_send()` and `delay()` inside the receive callback

The relay path calls `delay(5)` and then `esp_now_send()` from within
`OnDataRecv()`. Blocking the callback stalls the WiFi receive path — frames that
arrive during those 5 ms can be dropped. Calling `esp_now_send()` from the RX
callback is explicitly discouraged on ESP-IDF 5.x / Arduino-ESP32 3.x (both run in
the same WiFi task; it can back up or deadlock under load).

**Fix:** the RX callback does the minimum — validate length, copy into a FreeRTOS
queue, return. A separate task (or `loop()`) drains the queue: dedup, verify,
print, decide whether to relay, and send. No `delay()` anywhere in the RX path.

### S2-4 — `msg_id` generator collides across boards

`generateMsgId()` returns `(millis() & 0xFFFFFF) | (my_id << 24)`. `my_id` is a
32-bit value; `my_id << 24` keeps only its low 8 bits (which is `mac[5]`). So the
"node" part of every `msg_id` is just the last MAC byte.

**Failure scenario:** two boards whose MACs share the last byte, generating a
packet at a close `millis()` value, produce the **same** `msg_id`. The receiver's
dedup then drops the second one as a duplicate. Boards from one production lot often
have close or sequential trailing MAC bytes, so this is not rare.

**Fix:** drop `msg_id` as a packed field. Identify a packet by `(original_id, seq)`
where `original_id` is the full node id (already a field) and `seq` is a real
per-node monotonic counter (see §4 and §5).

### S2-5 — Baseline calibration divides by the wrong count

`calibrateBaseline()` takes 100 samples but only accumulates when
`Wire.available() >= 6`. It always divides by `samples` (100), not by the number of
reads that actually succeeded.

**Failure scenario:** intermittent I²C (a marginal jumper) yields, say, 50 good
reads. The baseline is then roughly half its true value. Every subsequent reading
has a large `delta_magnitude` → constant false alarms, or a baseline that never
settles.

**Fix:** count successful reads; divide by that. If too few succeed (e.g. < 80 of
100), retry the calibration or halt with a clear serial message rather than run
with a bad baseline.

### S2-6 — Type-2 ("distance map") reply amplifies traffic

Every sensor replies to every ping from every other sensor with a type-2 packet.
With N sensors that is N·(N−1) replies per ping cycle on top of the pings
themselves, plus relayed copies. With three sensors it is a low but constant extra
load that also keeps overwriting `last_msg_id` (worsening S1-2). The reply carries
`data_2 = manual_direction`, a hardcoded `90.0` — the feature is a stub.

**Fix:** either implement RSSI-based ranging properly, or remove the type-2
exchange from the design (and from any claim about direction-finding beyond the
per-alarm accelerometer angle).

### S3-1 — Dedup runs before sync handling

The `msg_id == last_msg_id` check returns before the type-0 sync branch. A sync
beacon that collides (S2-4) is dropped, the sensor never syncs, `getSyncedTime()`
returns raw `millis()`. Not fatal for the demo (the Pi timestamps on arrival) but
it breaks the "synchronised network" claim and would break any future channel
hopping.

### S3-2 — Stale payload on non-alarm packets

`myData` is not cleared between uses, so a ping carries whatever `data_1`/`data_2`
were last set by an alarm. Harmless while receivers ignore those fields for
non-alarm types, but it is one more thing the race in S2-2 can corrupt.

### S3-3 — ADXL345 sampling

The data rate register (`0x2C` / BW_RATE) is left at default (100 Hz ODR); the poll
loop runs at ~100 Hz (`delay(10)`), and there is a `delay(200)` after each alarm.
Short impacts, or a second impact within 200 ms, can be missed. I²C runs at the
default 100 kHz. For a rewrite: set the data rate explicitly, consider
`Wire.setClock(400000)`, and consider the ADXL345 FIFO (stream mode) to catch
events between polls.

### S3-4 — `%X` prints variable-length ids

`"orig_id":"%X"` drops leading zeros, so a node id like `0x00B0C4C0` prints as
`"B0C4C0"`. Consistent per node, but the downstream parser must treat the id as an
opaque string (which the Pi-side layer already does).

### Verified — not defects

- The receive-callback signature (`const esp_now_recv_info_t*`) is correct for
  Arduino-ESP32 core 3.x. If it compiles, the core matches.
- ADXL345 in FULL_RES / ±16 g mode has a fixed 3.9 mg/LSB scale, so `raw / 256.0`
  is approximately g. Correct.
- A RELAY prints only JSON (no `[SYNC]`, no banner) — clean for the parser.
- Receiving from a peer that was never added works; the broadcast peer is added
  only so the board can *send*.
- All boards are the same C3 with the same compiler, so the packed struct
  `memcpy` reinterpret is safe.

---

## 4. What a clean re-implementation should look like

Not code — the decisions that keep it correct.

### 4.1 WiFi / radio bring-up (identical on every board)

`WiFi.persistent(false)` → `WiFi.mode(WIFI_STA)` → `WiFi.disconnect(true, true)` →
`esp_wifi_set_ps(WIFI_PS_NONE)` → `esp_now_init()` (checked, logged) →
`esp_now_register_recv_cb` / `esp_now_register_send_cb` → add broadcast peer with
`channel = CH` → `esp_wifi_set_channel(CH, WIFI_SECOND_CHAN_NONE)` → print the
active channel. `CH` is a single shared `#define`.

### 4.2 Packet format (proposed)

| field | type | purpose |
|---|---|---|
| `version` | `uint8` | protocol/struct version; receiver drops a mismatch instead of misparsing |
| `original_id` | `uint32` | full node id (MAC bytes 2–5) |
| `forwarder_id` | `uint32` | id of the last relay; equals `original_id` when direct |
| `seq` | `uint32` | per-node monotonic counter (NVS-persisted); the dedup and replay key |
| `datatype` | `uint8` | 0 sync · 1 ping · 3 alarm (2 reserved / removed) |
| `timestamp` | `uint32` | synced ms; diagnostic only — the Pi uses arrival time |
| `hop_count` | `uint8` | incremented per relay; forwarded while `< MAX_HOPS` |
| `data_1` | `float` | alarm: magnitude (g) |
| `data_2` | `float` | alarm: bearing (deg, sensor frame) |
| `auth` | `uint8[8]` | present only in the secure build (see §5) |

`msg_id` is removed. Identity is `(original_id, seq)`.

### 4.3 Deduplication

A ring buffer of the last ~32 `(original_id, seq)` pairs, or a `last_seq` value per
known node. Checked before processing and before relaying. A packet already seen is
dropped silently (it is expected — it is a relayed copy).

### 4.4 Concurrency

One rule: the RX callback never blocks and never sends. It validates length and
pushes a copy to a queue. A worker (task or `loop()`) drains the queue and does all
real work. Every packet is built in a local struct; there is no shared packet
buffer.

### 4.5 Relaying

Forward a packet if it is new (dedup) and `hop_count < MAX_HOPS`. Increment
`hop_count`, set `forwarder_id`, send from the worker context.

### 4.6 Sensor path

Explicit ADXL345 data rate; count successful I²C reads in calibration; keep the
existing `atan2` bearing math and EMA baseline; consider the FIFO for short
impacts. Keep the alarm de-bounce but make it non-blocking (timestamp compare, not
`delay`).

### 4.7 Observability

Boot: print id, role, channel, `esp_now_init` result. Runtime: log TX failures,
log dropped-by-dedup counts periodically, log `esp_now_send` queue-full events. A
mesh that is misbehaving should say so on serial.

### 4.8 Time sync

Keep the one-way beacon. Document that accuracy ≈ the beacon interval. Do not build
anything (e.g. channel hopping) that needs tighter sync without first upgrading it.

---

## 5. Optional security layer (additive)

Two layers, independent. The firmware layer *prevents*; the Pi layer *detects*.
Neither requires the other.

### 5.1 Firmware: per-packet authentication

- Add `auth[8]` to the packet: a truncated HMAC-SHA-256 (or AES-CMAC) over all
  preceding fields, keyed with a pre-shared key. `mbedtls` is already in the SDK.
- Sender computes it before transmit. Receiver recomputes and compares as the first
  step in the worker; a mismatch drops the packet.
- **Protects against:** a foreign node injecting or altering packets. A rogue board
  with the firmware but not the key cannot produce a packet any node will accept.
- **Cost:** ~15 lines each on the send and receive sides; a few microseconds per
  packet on the C3 (hardware SHA); +8 bytes per packet (still far under the 250-byte
  ESP-NOW limit).

### 5.2 Firmware: monotonic sequence + replay rejection

- The `seq` field (already proposed in §4.2) is a per-node counter, incremented on
  every send, **persisted to NVS in bursts** (write `seq + 256` to NVS, resume from
  the stored value on boot — survives resets, guarantees monotonicity, and avoids
  flash wear).
- Receiver keeps `last_seq` per `original_id`; rejects `seq <= last_seq`.
- **Protects against:** capture-and-replay of a valid packet.
- **Cost:** small; mostly getting the NVS burst logic and the reboot case right and
  tested.

### 5.3 Firmware: payload encryption (lower priority)

- AES-128-CTR over `data_1`/`data_2`, nonce = `original_id || seq`. Hides the
  magnitude and bearing from a passive sniffer.
- **Note:** ESP-NOW's built-in encryption (`peerInfo.encrypt`) is unicast-only and
  capped at six encrypted peers, so it does **not** fit this broadcast-flood
  design. Encryption has to be at the application layer.
- **Cost:** ~15 more lines. For a ground-sensor network the payload is low-secrecy,
  so authenticity (5.1) matters more than confidentiality.

### 5.4 Pi side: behavioural monitor (already built)

A dependency-free module the Pi feeds every relayed message. It flags: an unknown
node id, a replayed message (by observation), a node sending far above the normal
rate, physically impossible values, and correlated silence (jamming). It marks
untrusted nodes so their data is dropped from the operator picture. It **detects**,
it does not block.

### 5.5 Build toggle

Put 5.1–5.3 behind a compile flag (`#define SECURE_MESH 1`). With it at `0` the
build is byte-for-byte the pre-security behaviour, so the reliability rewrite can
be validated first and the security layer added and A/B-tested after.

---

## 6. Risks (realistic)

1. **Pre-shared key in firmware.** A physically stolen node reveals the key; an
   attacker can then forge valid packets for the rest of the event. The production
   answer is an eFuse-stored key with Secure Boot and Flash Encryption — those are
   irreversible once burned and risky to enable under time pressure, so they are
   out of scope here. For the demo the shared key is acceptable; state it plainly
   in the pitch.
2. **No key rotation.** If the key leaks mid-event, recovery means re-flashing
   every board.
3. **All-or-nothing rollout.** Any change to the packet struct (size or `version`)
   means every board must run the same build at the same time. A stale board is
   silently mute (`len != sizeof` → dropped). Plan the reflash as one step.
4. **Sequence / NVS handling.** Persist on every packet → flash wear (~100k write
   endurance). Do not persist → a reboot resets `seq` and the receiver rejects that
   node until its `last_seq` is cleared. The burst-persist pattern solves both but
   must be implemented and tested for the reboot case specifically.
5. **Sync loss looks like jamming.** A node that loses time sync, or ends up on the
   wrong channel, goes silent — the Pi layer will flag `jamming_suspected`. That is
   not wrong, but it can cry wolf on a mundane glitch. Mitigate by having the
   firmware emit a distinct "cannot reach mesh" status the Pi can tell apart.
6. **Channel hopping (if pursued later).** 2.4 GHz has only three non-overlapping
   channels (1, 6, 11), so hopping beats a cheap single-channel jammer but not a
   wideband one or three cheap ones. It also needs tight, two-way time sync that the
   current one-way beacon does not provide — adding it introduces a new failure mode
   (desync = looks jammed). Treat it as a post-demo item, not a requirement.
7. **Detection-only ceiling (Pi layer).** A forged packet that copies a real node's
   id and keeps every value in range is indistinguishable from genuine traffic
   without the firmware auth tag (5.1). A replay re-sent with a fresh `seq` cannot
   be caught by behavioural means. These are exactly the gaps 5.1 and 5.2 close.
8. **Time budget.** The auth + seq additions are ~40–60 lines but need bench
   testing on all boards: traffic still flows with the check on, reboot behaves,
   no partial rollout. Realistically a few hours including flashing. If the
   reliability rewrite itself consumes the weekend, security slips — so sequence it
   after "the mesh is reliable", not before.
9. **Rewrite risk itself.** The current firmware, buggy as it is, has been debugged
   against real hardware (I²C timing, ADXL register setup, ESP-NOW quirks on the
   C3). A from-scratch rewrite re-opens those integration risks. Keep the
   known-good hardware pieces; rewrite only the structure.
10. **Overclaiming.** The type-2 "distance map / RSSI direction-finding" is a stub.
    Either implement it or drop it from the design and the pitch. The only real
    direction information is the per-alarm accelerometer bearing, and that bearing
    is in the sensor's mounting frame, not true north.

---

## 7. Recommended order of work

- **P0 — Reliability.** Channel pinned, power-save off, robust `(original_id, seq)`
  dedup, no work in the RX callback, local packet buffers, `MAX_HOPS` forwarding,
  init/TX/queue logging, I²C-read robustness in calibration. Target: solid with
  three sensors + one relay + one hub.
- **P1 — Pi integration.** Feed the hub JSON into the pipeline and the behavioural
  monitor; one live attack demo (rogue-node injection → node marked, picture stays
  clean).
- **P2 — Firmware security.** `auth` tag + `seq` replay rejection behind
  `SECURE_MESH`. Reflash all, bench-test.
- **P3 — Extras.** Payload encryption; channel hopping. Only if P0–P2 are locked
  with time to spare.

## 8. How to verify each fix

| fix | check |
|---|---|
| Channel pinned | every board prints the same `[CH] n` at boot |
| Init / TX visibility | no `esp_now_init FAILED`; `[TX FAIL]` count stays ~0 under normal load |
| Dedup | with 3 sensors + 1 relay, each alarm appears **once** at the hub; a periodic "dropped N duplicates" log is non-zero and stable |
| `MAX_HOPS` | `sensor → relay → relay → hub` delivers; `hops` field shows 2 |
| No RX-callback blocking | under a burst from all sensors, no drop in received count vs sent count beyond a small margin |
| Baseline calibration | after a deliberately flaky I²C connection, the board refuses to run or logs a retry, instead of alarming continuously |
| `SECURE_MESH` A/B | build `0` = current behaviour; build `1` = same traffic still delivered, and a packet with a wrong/absent `auth` is dropped |
| Replay rejection | replaying a captured frame is rejected; the same node after a reboot re-joins within one `seq` burst window |
