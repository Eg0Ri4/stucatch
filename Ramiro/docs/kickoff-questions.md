# Kickoff — Questions to answer before we start building

**Team:** UGS Mesh · **Event:** EDTH Hamburg, 28–30 Aug 2026

Work through this together. Fill in **Decision:** on each line. Part 1 blocks starting
to code; Part 2 by end of Friday; Part 3 before Saturday afternoon.

**Hardware (given):** 2× ESP32-C3 Mini sensor nodes · 1× ESP32-C3 Mini root/gateway
(USB serial to the Pi) · Raspberry Pi as the base + dashboard.

**Decided so far (28 Aug):** painlessMesh · ESP32-C3 · **no AI / no ML model** ·
**no microphone available** (acoustic modality is simulated, hook left ready) ·
Ramiro owns the Pi-side software and writes the sketches, Yurii flashes & tests.

---

## PART 1 — Answer now (blocks starting to code)

### Roles

- **Q1. Who owns the Pi-side software** — ingest from serial, sensor fusion, alerting,
  dashboard?
  **Decision:** Ramiro. ✅

- **Q2. Who owns the node firmware** — sensor read + mesh + `sendData()` + root serial
  output?
  **Decision:** Ramiro writes the sketches (`firmware/`), Yurii flashes & tests. ✅

- **Q3. Who owns edge detection / any ML model** (if we do a real one)?
  **Decision:** N/A — no AI / no ML model. Dropped. ✅

- **Q4. Who owns the repo + integration** — git, branches, docker, first node→Pi
  hookup?
  **Decision:** ______  (OPEN — needed now, see Q25)

- **Q5. Who narrates the pitch and takes Q&A** (best spoken English)? Ramiro drives the
  live technical demo.
  **Decision:** ______  (OPEN)

### Hardware specifics

- **Q6. Exact ESP32 variant?**
  **Decision:** ESP32-C3 Mini. ✅

- **Q7. What sensor is physically on each of the 2 nodes?**
  No microphone. **OPEN — decide what IS on them for Saturday:**
  - (a) PIR motion sensor — cheap, digital HIGH on motion, maps to the sketch as-is
  - (b) vibration / tilt (SW-420) — also digital HIGH
  - (c) a button — a deliberate trigger for the live demo
  - (d) nothing physical — nodes send keepalives only; detections come from the simulator
  **Decision:** node A = ______ · node B = ______

- **Q8. What does a "sensor event" look like in code?**
  *Sketch currently assumes:* a GPIO pin reads HIGH (works for PIR / vibration / button).
  **Decision:** ______  (confirm once Q7 is set; also: fixed confidence on trigger, or
  derived from an analog level?)

- **Q9. Do the nodes know their own position?**
  **Decision:** No GPS — node sends only its `node_id`; the Pi holds positions in
  `config/nodes.json`. ✅ (already built this way)

- **Q10. For the demo, how many nodes?**
  *Strong recommendation:* 3 physical (prove the mesh + serial + ingest are real) **+**
  simulated nodes mixed in (provide the intruder scenario, since there's no real sensor
  for it). The gateway already accepts both on the same `/ingest`.
  **Decision:** ______

### Mesh & transport

- **Q11. Mesh library:**
  **Decision:** painlessMesh. ✅ (sketches in `firmware/`)

- **Q12. Root → Pi link format:** newline-delimited JSON over USB serial, baud 115200?
  **Decision:** ______  (this is what the sketch + bridge already do; just confirm)

- **Q13. Timestamps:** nodes have no clock — node sends `seq`, the Pi stamps arrival
  time.
  **Decision:** ______  (already built this way; confirm)

### Message contract (freeze this today)

- **Q14. Confirm the JSON a node emits per event:**
  ```json
  { "node_id": "N03", "seq": 1421, "modality": "acoustic",
    "detection": { "class": "drone", "confidence": 0.82 } }
  ```
  Pi adds `ts` and `pos` on arrival. **Decision (fields):** ______  (frozen in
  `app/models.py` + `firmware/`; confirm no field changes)

- **Q15. Class vocabulary:** `drone | person | vehicle | unknown | clear` — agreed?
  **Decision:** ______

- **Q16. Keepalive:** every node sends `class:"clear"` every ___ seconds.
  **Decision:** N = ______  (sketch default: 5)

### Detection for the demo

- **Q17. Real model or simulated labels for Sunday?**
  **Decision:** No AI / no ML. The **simulator** produces `class` + `confidence` for
  the intruder scenario. A physical node, if it has a sensor (Q7), sends a fixed
  class/confidence on a hardware trigger — a threshold, not a classifier. ✅

- **Q17b. What actually makes a *physical* node "detect" in the live demo?** (button
  press / hand in front of a PIR / tap a vibration sensor). This is the credibility of
  the on-stage moment. **Decision:** ______

---

## PART 2 — Answer by end of Friday

### Security scope

- **Q18. v1 message protection:** none / HMAC signing only / AES-256-GCM (encrypt +
  authenticate)?
  *Proposed:* none for v1, add signing then encryption as separate isolated steps
  (see `docs/encryption-esp32c3.md`).
  **Decision:** ______

- **Q19. If we sign/encrypt:** can the firmware add it, and who generates + stores the
  per-node keys?
  **Decision:** ______

- **Q20. Which security demo features are in scope?** signed messages / node trust
  score (Pi-side) / jamming detection (Pi-side).
  *Note:* the two Pi-side ones are low risk and are Ramiro's; signing needs firmware.
  **Decision:** ______

### Dashboard & demo

- **Q21. Where does the dashboard run — on the Pi or on a laptop on the same network?**
  *Why:* Streamlit can be heavy for a Pi.
  **Decision:** ______

- **Q22. Map tiles:** is there reliable internet at the venue? If not, we need offline
  map tiles or a plain coordinate plot.
  **Decision:** ______

- **Q23. Reference site for the map** — a concrete port / base / perimeter near
  Hamburg, just for the visual.
  **Decision:** ______

- **Q24. Write the scripted demo scenario** — step by step, 60–90 seconds.
  **Decision:** ______

### Repo & integration

- **Q25. Repo host** (GitHub?), who creates it, everyone's usernames.
  **Decision:** ______  (NEEDED NOW — code is being committed locally with no remote;
  Yurii needs to pull `firmware/`. Someone create a repo and share the URL.)

- **Q26. Branch strategy:** `main` + feature branches, direct push or PRs?
  **Decision:** ______

- **Q27. First node→Pi integration test — when?** (target: Saturday afternoon)
  **Decision:** ______

---

## PART 3 — Confirm before Saturday afternoon

- **Q28. Power for the demo nodes:** USB power banks / batteries / bench supply?
  **Decision:** ______

- **Q29. Real multi-hop in the demo?** (one node out of the root's range, relayed by
  the other node) or all nodes close together?
  **Decision:** ______

- **Q30. RF environment:** 2.4 GHz WiFi will be crowded at the venue. Do we test the
  mesh early in that environment? Fallback if it's unreliable?
  **Decision:** ______

- **Q31. Backup demo video** — who records it Sunday 09:00, on what.
  **Decision:** ______

- **Q32. Docker:** only for Ramiro's Pi-side services, or do the hardware folks need it
  too?
  **Decision:** ______

- **Q33. Presence schedule** — who is at the venue when; when is Ramiro's home focus
  sprint (Saturday), and how do we stay in sync during it.
  **Decision:** ______

---

## Once Part 1 is answered, Ramiro starts:

1. Repo + `docker compose` + FastAPI skeleton with `/health`.
2. Data models: `Node`, `Detection`, `Track`, `Alert`.
3. Mesh **simulator** emitting the agreed JSON → build the whole Pi-side against it.
4. In parallel: painlessMesh sketches (sensor node + root) for Yurii to flash.
