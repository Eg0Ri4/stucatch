# Security measures — UGS mesh (ESP32 sensors + Raspberry Pi)

This document covers the security measures currently in force across both halves
of the system — the ESP32 firmware that runs on every node, and the Raspberry Pi
that consumes the mesh — and the measures that are designed but not yet
implemented, with the reason each one matters.

Part 1 is a summary written for reviewers and the presentation. Part 2 is the
full detail for the team.

---

## Part 1 — Security posture (summary)

### The design decision

The system is built **detection-first**. In the time available we chose to make
an attack on the mesh *visible* rather than *impossible*: the firmware carries no
cryptography, and the Pi-side logic is meant to identify a bad actor rather than
block one. This is a deliberate scoping decision for a prototype, not an
oversight — message authentication is the first addition planned (Part 2).

### What protects the system today

**On the node (firmware).** The radio receive path cannot be stalled by a packet
flood: it checks only a frame's size and version before queuing it, and it works
from fixed-size buffers with no dynamic memory. Every frame is then checked
against the exact shape its type requires before any payload field is read;
anything malformed is counted and dropped. Duplicate and naively replayed frames
are filtered out by a per-sender recent-history table, so they are not relayed
onward. Re-broadcasts are limited to two hops, so one frame cannot storm the
mesh. Each node seeds its message counter from a random value at power-on rather
than a fixed one. Transmit power is held low, which keeps the radio footprint
small. The node runs no IP networking and accepts no connections — its only
attack surface is the raw mesh-frame parser just described.

**On the Raspberry Pi.** The Pi is a passive consumer: it takes the raw serial
JSON line from the gateway and never transmits to the mesh, and the gateway
firmware never reads back from that link, so the Pi cannot be used to inject into
the mesh. Hardened parsing of the stream and the anomaly checks are part of the
detection layer below, which is not yet integrated.

### What is designed and deferred

Message authentication (a keyed signature on every frame, so a sender's identity
cannot be forged), replay protection that survives a reboot, payload
confidentiality, channel agility against jamming, and tamper resistance on a
captured node — none of these are built yet. The behavioural-detection layer for
the Pi — eleven checks covering injected nodes, replay, flooding, a rogue time
source, jamming, impossible values, silent nodes and more — is built and tested
but not yet wired in. Part 2 details each.

### The adversary's view

The most direct attack is **node injection**: an adversary places their own radio
near the site and feeds the mesh false "all clear" data or fake alarms. Today the
firmware accepts those frames; the deferred detection layer flags a sender it
never learned, and message authentication would reject them outright. A
**replayed** frame — a captured "all clear" re-sent later — is caught by the
detection layer unless the attacker also advances the counter; authentication
would stop that case too. **Jamming** channel 6 silences the mesh; the detection
layer tells a coordinated outage apart from a single dead node, and channel
agility is the planned mitigation. A **passive listener** can currently read
every payload off the air; confidentiality is deferred. Low transmit power
shrinks the footprint but does not defeat a capable direction-finder.

---

## Part 2 — Technical detail (team)

### In force — ESP32 firmware (`logicv6`)

**Receive path is flood-resistant.** `OnDataRecv` rejects any frame shorter than
the header or longer than `FRAME_MAX` (64 bytes), rejects any frame whose first
byte is not the protocol version, then copies it into a 16-slot ring and
returns. If the ring is full the frame is counted (`overflow_count`) and
dropped. All parsing, dedup and forwarding happen later in `loop()`. A burst of
traffic cannot block the callback or grow memory.
*Why it matters:* the cheapest attack on any radio is to drown it. This keeps a
flooded node responsive and bounded instead of locking up.

**Fixed-size everything.** `FRAME_MAX` 64, receive ring 16, dedup table 16,
alarm-resend buffer 4. No heap allocation on the hot path; memory use is constant
regardless of traffic.
*Why it matters:* no allocator means no memory-exhaustion or fragmentation crash
under sustained load.

**Strict frame-shape check.** Before reading any payload field,
`processReception` looks up the exact payload size for the frame's kind; an
unknown kind, or a length that is not `header + expected payload` exactly, is
dropped with a logged reason.
*Why it matters:* a frame with a valid version byte but a wrong kind or a
truncated payload cannot be misread as something it is not.

**Self-echo ignored.** A frame whose origin is this node's own ID is discarded.
*Why it matters:* prevents a node from acting on its own relayed traffic and
looping.

**Bounded dedup (`witness`).** A 16-entry per-origin table with
least-recently-used eviction. "Newer" is a wraparound-aware signed comparison of
the 16-bit counter. Outcomes for a known sender: a higher counter is new and
accepted; the exact same counter within 5 seconds is a duplicate and dropped —
this absorbs the three copies of each alarm; the exact same counter between 5 and
60 seconds is treated as a delayed resend and accepted; a lower counter is a
duplicate. An entry more than 60 seconds stale is ignored, so a node that
rebooted with a fresh random counter is accepted again after about 60 seconds of
silence. This gates relaying and range replies only — every frame, duplicates
included, is still printed to the serial line for the Pi.
*Why it matters:* keeps a duplicate or a casually replayed frame from being
relayed onward, which is what would turn one frame into a broadcast storm. It is
not replay protection — see Honest limits.

**Hop cap.** `MAX_HOPS` 2. A relay forwards a frame only if it is not a known
duplicate and its hop count is below the cap. A frame therefore travels at most
two relay-hops from its origin, and no relay re-forwards a frame it has already
seen.
*Why it matters:* without a cap, relays re-forwarding each other's copies turn a
single frame into an expanding broadcast storm.

**Random counter seed.** At boot `my_seq = esp_random()`.
*Why it matters:* a rebooted node resumes from an unpredictable point instead of
a fixed value, which avoids counter collisions with its own pre-reboot frames
still sitting in a receiver's table. It is not forgery protection — an attacker
who hears one frame from the node knows its counter (see Honest limits).

**Low transmit power.** `WIFI_POWER_8_5dBm`, well below the radio's maximum.
*Why it matters:* a smaller emission footprint is harder to detect and
direction-find from a distance, and reduces mutual interference between nearby
nodes.

**No IP networking.** The node uses Wi-Fi in station mode but never associates
with an access point; it speaks only ESP-NOW at the link layer. `WiFi.persistent`
is off, so no Wi-Fi credentials are written to flash. There is no listening
socket and no association handshake.
*Why it matters:* the entire TCP/IP and Wi-Fi-association attack surface is
simply absent. The only way in is a raw protocol-v4 frame on channel 6.

**Reboots are visible.** Boot count is stored in NVS (`Preferences`) and rises by
one each power-on, carried in every status frame.
*Why it matters:* the Pi can see a node being power-cycled or crashing
repeatedly. It is a weak tamper signal at best — a captured node can be
reflashed.

**No link-layer cryptography.** ESP-NOW is initialised with `encrypt = false`.
This is the boundary: any device on channel 6 speaking protocol v4 is trusted by
the firmware. Everything in the next section addresses this.

### In force — Raspberry Pi

**Passive consumer.** The Pi takes the raw serial JSON line from the gateway, one
record per mesh frame, and does not transmit to the mesh. The gateway firmware
never reads back from the serial link (verified in `logicv6`), so there is no
path from the Pi into the mesh.
*Why it matters:* the Pi cannot be used as an injection point.

**The detection layer is not integrated yet.** Until it is, the Pi renders the
mesh picture but runs none of the checks in the next section.

### Designed and deferred

**Integrate the detection module.** A single dependency-free file that consumes
the same serial stream and flags: an injected node (`unknown_node`), a replayed
frame (`replay`), one sender transmitting far too fast (`rate_spike`), a flood of
fabricated sender IDs (`id_flood`), a time-authority frame from a non-hub
(`rogue_sync`), several nodes going silent together (`jamming`), a field value
the hardware cannot produce (`impossible`), a node that stopped reporting
(`silent`), an unparseable frame (`malformed`), a node reboot (`node_reboot`),
and recovery from silence (`recovered`). Built and tested — 42 cases, a clean
400-second run with no false positives, a 15000-line junk fuzz that never threw
and stayed within its memory bounds. Detection only; not yet wired into the Pi
pipeline.
*Why it matters:* this is the whole "make the attack visible" half of the
posture. Without it the operator sees the mesh but not the anomalies in it.

**Message authentication.** An HMAC over the frame header and payload, keyed with
a pre-shared secret flashed into every node of one deployment.
*Why it matters:* makes the origin field unforgeable, which closes node
injection, frame tampering, and the rogue time source in one step. It is the
single highest-value addition. Needs a key-provisioning step at flash time.

**Replay protection that survives reboot and eviction.** Persist a per-origin
high-water counter in NVS and reject anything at or below it, combined with the
existing epoch field.
*Why it matters:* closes the replay paths that rely on the 60-second age-out or
on eviction from the 16-entry table. A replay with a forged higher counter still
gets through until message authentication is in place.

**Payload confidentiality.** Encrypt the payload at the application layer
(AES-CCM with a key derived from the same pre-shared secret as the HMAC).
ESP-NOW's built-in encryption only covers unicast peers, not the broadcast this
mesh uses, so it has to be done inside the frame.
*Why it matters:* stops a passive listener reading alarm magnitude and bearing,
RSSI-based ranging, and node status straight off the air.

**Channel agility against jamming.** When several nodes fall silent at once,
retune all nodes to a pre-agreed fallback channel on a shared schedule.
*Why it matters:* a jammer parked on channel 6 currently takes the mesh down for
as long as it is there. Agility turns that into a short gap.

**Node-capture resistance.** ESP32 Secure Boot v2 and Flash Encryption.
*Why it matters:* a recovered node does not yield the firmware image or, once it
exists, the shared key. Adds provisioning complexity and makes boards
unrecoverable if keys are lost.

**Deployment provisioning.** Record each node's real origin ID as it is placed
and pass the list to the detection module as a fixed allowlist, instead of
relying on the learn window to infer it.
*Why it matters:* removes the timing assumption (all nodes powered before the
window closes) and the small chance of trusting an attacker who transmits during
it.

### Honest limits (not sure if include this or not)

- **No firmware cryptography today.** Any device on channel 6 that speaks
  protocol v4 is trusted. Everything on the Pi is detection, not prevention: it
  can name a bad actor, it cannot stop one.
- **The firmware dedup is not replay protection.** It is a 16-entry
  recent-history filter. A replay with a higher counter, a replay after the
  60-second age-out, or a replay after the sender's slot is evicted all pass.
- **`unknown_node` only catches a fresh ID.** An attacker who clones a real
  origin — readable by sniffing one frame — is not flagged by that check. It is
  partly covered by `replay`, `rate_spike` and `rogue_sync`, and fully only by
  authentication.
- **Payloads are plaintext on air.** Alarm magnitude and bearing, RSSI ranging,
  and node status are readable by any passive listener on the channel.
- **SYNC is unauthenticated and not de-duplicated.** A rogue hub, or a replayed
  SYNC frame carrying the real hub's ID, shifts every node's clock; the firmware
  applies the offset regardless. The detection layer flags the wrong-origin case
  (`rogue_sync`) and a stale replay (`replay`) — but nothing prevents the shift.
- **Low transmit power is not stealth.** It shrinks the RF footprint but does not
  prevent detection or direction-finding by a capable adversary.
- **The detection layer is not integrated yet.** As of now the Pi shows the
  picture but runs none of these checks.
