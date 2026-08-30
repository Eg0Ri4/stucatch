# Security Q&A — anticipated questions
---

## The design decision

**Q: Your firmware has no encryption or authentication. Why?**
A: A deliberate scope call for a 48-hour prototype. We spent the time on the
sensing and the mesh — the parts that prove the concept.
Security is a layered plan: the firmware is hardened against disruption today;
the anomaly-detection module — built and tested, being wired in — makes an attack
visible; and message authentication is the first cryptographic step planned. We
chose to make the attack *visible* first and *impossible* second.

**Q: Isn't detection without prevention useless?**
A: No. The operator's job here is to know the picture is being tampered with. A
flagged "unknown node" or "replayed frame" tells the patrol the feed is
contested, which changes how they act on it. Prevention is better and it's next,
but visibility has standalone value.

**Q: How is this deployable if anyone on the channel can inject frames?**
A: Not as an unattended system yet — that needs the HMAC layer. As a monitored
system it's close: wire in the detection module (built and tested) and an
operator watches for injected or replayed frames. We're claiming a working core
with a credible security path, not field-ready.

---

## Attacking the mesh

**Q: What stops me dropping my own sensor next to the site and feeding you fake "all clear" data?**
A: Nothing in the firmware today. The detection module flags it as `unknown_node`:
its ID isn't in the provisioned node list — or, if we didn't provision one, it
first transmits after the 40-second learn window. If you clone one of our real
IDs instead, that check won't catch you; `replay`, `rate_spike` and `rogue_sync`
might, and message authentication would end it.

**If pushed — "so a careful attacker gets in":** Yes. If you cleanly take over a
real node's identity — same ID, normal rate, counter kept consistent — the
current checks don't reliably catch you. That is exactly the gap authentication
closes, and it's why HMAC is first on the roadmap.

**Q: Can I record a frame off the air and replay it later?**
A: A byte-exact replay is caught by the detection module — the counter is behind
what we've already seen from that node, so it's flagged as `replay`, and the
firmware's dedup filters a recent one from the mesh. What gets through is a
replay where you edit the counter upward; that's really forgery, and it needs
authentication.

**Q: What if I replay a SYNC frame — the time beacon?**
A: A real gap. A non-hub sending SYNC is flagged (`rogue_sync`); a replayed SYNC
carrying the real hub's ID is caught as a stale `replay` by the detection module,
but the firmware applies the time offset before anything flags it. It corrupts
timestamps, not detections. Authenticating SYNC fixes it.

**Q: I jam channel 6. Your whole mesh is down, right?**
A: While the jammer is on, yes — every node is on one fixed channel. The
detection module turns that into one clear signal: several nodes going silent
within seconds of each other is reported as one jamming / coordinated-outage
alert, not a wall of separate node failures. The mitigation is channel agility —
retune to a fallback channel when several nodes drop at once — which is on the
roadmap, not built.

**Q: Can an adversary read your sensor data by listening?**
A: Yes, today. Payloads are plaintext: alarm magnitude and bearing, signal-based
ranging, node health. Low transmit power keeps the footprint small but that is
not confidentiality. Payload encryption is on the roadmap, sharing the key with
the HMAC layer.

**Q: I capture a node. What do I get?**
A: Today, the firmware image and — once it exists — the shared key, because
there's no secure boot or flash encryption yet. That's the argument for adding
both, and for treating the key as per-deployment and rotatable, since some nodes
will be lost.

**Q: Can I flood you off the air?**
A: The firmware is built for that. The receive path validates only size and
version before queuing, from fixed buffers with no dynamic memory, so a flooded
node stays responsive and drops the excess. Re-broadcasts are capped at two hops
so one frame can't storm the mesh, and the detection module flags it as a rate
spike (one ID) or an ID flood (many fabricated IDs).

**Q: The link between the mesh and the Pi — isn't that a single point of failure?**
A: The bridge board isn't a special build. Every board prints the frames it hears
on its serial line, so any node can bridge to the Pi — the hub is the natural
pick since it also emits the time sync. If that board or its cable fails, move
the Pi to another node. The real single point is the Pi itself: if it dies the
mesh keeps running, but nobody is watching until it's replaced.

---

## The detection layer

**Q: What exactly does it catch?**
A: Eleven things — an injected node, a replayed frame, one sender transmitting
too fast, a flood of fake sender IDs, a time beacon from the wrong node,
coordinated silence (jamming), physically impossible field values, a node that
went dark, a malformed frame, a node reboot, and recovery from silence.

**Q: How many false alarms does it throw?**
A: In testing, zero on a clean 400-second run of a hub, two sensors and a relay
with realistic traffic, and it survived 15,000 lines of garbage input without
crashing or leaking memory. Field traffic will differ; every check tunes or
switches off from config without touching code, and turning a noisy one off
doesn't break the others.

**Q: Does it hold up with 20 or 50 nodes?**
A: Memory is bounded by design — fixed node table, fixed event log, per-second
counters — so it can't grow unbounded. Thresholds (rate, silence timeouts, fleet
size) are config values set per deployment; the node-count limit in particular
has to be set at or above the real fleet size, or a legitimate large fleet trips
the `id_flood` check. We tested at small scale; large-scale tuning is untested.

**Q: You built this but it's not running in the demo system?**
A: Correct, and we say so. It's a finished, tested module — one file, no
dependencies — that consumes the exact serial stream the Pi already reads. It
isn't wired into the dashboard yet. Integrating it is a small, defined task, not
a rewrite.

**Q: Why is it separate from the firmware?**
A: The firmware can't afford it and the Pi can. The node is a small
microcontroller doing real-time sensing; the analysis lives where there's CPU and
memory. The firmware does only what it must — validate, dedup, cap hops, stay
alive.

---

## Roadmap and feasibility

**Q: Is the security roadmap realistic or a wish list?**
A: It's scoped to what the hardware already supports. HMAC over each frame with a
flashed key — standard. A persistent counter in the flash the node already uses —
standard. Payload encryption with the same key — standard. Secure boot and flash
encryption are built into the chip. None of it needs new hardware.

**Q: What's the single most important thing to add?**
A: Message authentication. One keyed signature per frame makes the sender ID
unforgeable, which closes node injection, frame tampering and the rogue time
source in one move. Everything else is narrower.

**Q: What does authentication cost you?**
A: Around 8–16 bytes per frame for the signature, and a key-provisioning step
when boards are flashed. If nodes verify on receive, the JSON the Pi consumes
doesn't change. Replay across reboots still needs the persistent counter on top.

---

## Alternatives and cost

**Q: Why not use an existing secure mesh — Thread, Zigbee, LoRaWAN?**
A: Those give you link security but tie you to their stack and provisioning
model. We wanted a bare, cheap ESP-NOW broadcast mesh we fully control, with
security in a thin layer we can reason about. For a prototype that trade was
worth it; a production version could reconsider.

**Q: Does the security layer add cost?**
A: Almost none. The firmware hardening is code. The detection module runs on the
Pi that's already there. HMAC and encryption are compute on hardware we already
have. The only real cost is key provisioning at flash time.

**Q: With the whole roadmap built, how does the adversary still beat it?**
A: The remaining paths are physical or key-based — extract the shared key from a
captured node by defeating flash encryption, then forge freely until the next key
rotation, or jam persistently across every fallback channel with a wideband
transmitter. Capturing a node trips the `silent` alert; persistent jamming is
loud and RF-locatable. There's no quiet software defeat once frames are
authenticated and encrypted.
