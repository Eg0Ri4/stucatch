## 1. Summary

A low-cost mesh of unattended ground sensors (UGS) that watches a fixed site or
perimeter and fuses every node's observations into **one coherent, evidence-grade
situational picture**: what was detected (infantry, drone, vehicle), where, with what
confidence, and with a raw-data evidence trail — enough to task a patrol or an
boarding decision. Security against attacks on the sensor layer itself is a
first-class feature, not an afterthought.

## 2. Problem & user

- **User:** an operator defending a fixed site or approach (port, base, energy node,
  border sector).
- **Pain:** small, low-signature intruders (dismounted infantry at night, a quadcopter
  carrying an explosive) cross undetected. Where sensors exist, they fire
  independently — the operator sees a wall of alarms and cannot tell one intruder seen
  by five sensors from five separate threats, so response stalls.
- **Challenge asks for:** an affordable, layered detect–classify–alert system that
  fuses its sensors into **one coherent picture**, plus an explicit answer to *how the
  adversary attacks or interferes with the solution*.

## 3. System overview

1. **Nodes.** Cheap battery units (ESP32 + one sensor: microphone, PIR motion,
   geophone/vibration). Scattered across the terrain, unattended.
2. **Edge inference.** Each node runs a pre-trained model locally and emits a short
   message — *"N03: drone, 10:15:03, conf 0.82"* — not raw audio/video.
3. **Mesh.** Nodes relay each other's messages hop by hop to a root node; if one fails
   the message finds another path.
4. **Fusion core (our software).** On a laptop: associates detections into per-object
   tracks, fuses confidence across modalities, classifies threat, decides alerts,
   stores evidence, scores each node's trustworthiness.
5. **Operator view.** A map of nodes and moving tracks, plus a prioritised alert feed
   with evidence on click.

## 4. Architecture

```
  UGS NODES (xN)              MESH                 FUSION CORE (laptop)          OPERATOR
 ┌───────────────┐        ┌───────────┐        ┌───────────────────────┐     ┌──────────┐
 │ mic / PIR /   │        │           │        │  Gateway: verify sig  │     │ Map +    │
 │ geophone /    │─detect─▶│ relay mesh│─JSON──▶│  + validate + persist │────▶│ alert    │
 │ camera / RF   │ (edge  │ (ESP-NOW /│ signed  │  Fusion → tracks      │     │ feed +   │
 │  + ESP32      │ model) │  LoRa /   │ per node│  Alerting + evidence  │     │ evidence │
 │               │        │  MQTT)    │        │  Node trust scoring    │     │          │
 └───────────────┘        └───────────┘        │  API (FastAPI, DuckDB) │     └──────────┘
        │                                      └───────────────────────┘
        └── MESH SIMULATOR: synthetic nodes emit the same signed JSON ──┘
```

### Message contract (node → core)

```json
{
  "node_id": "N03",
  "seq": 1421,
  "ts": "2026-08-30T10:15:03.412Z",
  "pos": { "lat": 53.54051, "lon": 9.98931 },
  "modality": "acoustic",
  "detection": { "class": "drone", "confidence": 0.82 },
  "raw_ref": "N03/clip_20260830_101503.wav",
  "sig": "hmac-sha256 over the canonical JSON of all fields except sig"
}
```

- `modality`: `acoustic | seismic | pir | magnetometer | rf | camera`
- `detection.class`: `drone | person | vehicle | unknown | clear`
- `seq`: monotonic per node → replay protection.
- **Keepalive:** the same message with `class:"clear"` every N seconds → lets the core
  know a node is alive (required for jamming/dropout detection).
- `sig`: HMAC-SHA256 with a per-node symmetric key provisioned at deployment.

**Freezing this contract on Friday is the top priority** — it lets hardware and
software progress in parallel without blocking each other.

## 5. Work split

| Area | Owner |
|---|---|
| Physical nodes: board, sensor, wiring, soldering, flashing | Hardware team (Yurii) |
| On-board mesh firmware (ESP-NOW / painlessMesh) | Yurii (software pairs on the code if needed) |
| Per-message HMAC signing in firmware (~5 lines, mbedTLS) | Yurii, from the contract |
| Camera + pre-trained detection (optional bonus) | Pruthviraj |
| **Gateway, fusion core, alerting, evidence, dashboard** | **Ramiro** |
| **Mesh simulator** | **Ramiro** |
| **Security layer (auth, node trust, jamming detection)** | **Ramiro** |
| Repo infra: git, feature branches, docker compose | Ramiro |

**Boundary:** once data leaves the root node, it is software.

## 6. Software core (Ramiro)

- **Gateway** — `POST /ingest`: verify signature, validate schema, track node
  liveness, persist to DuckDB. Also `/nodes`, `/tracks`, `/alerts`, `/health`.
- **Fusion** — a new detection joins an existing track if within `Δt` (~8 s) and `Δd`
  (~150 m, per-modality tunable) of its last update; otherwise opens a track. Track
  confidence combines per-detection confidence, is boosted when ≥2 distinct modalities
  agree, and decays with time since last update. Class = trust-weighted majority vote.
  Lifecycle: `tentative → confirmed → stale → closed`.
- **Alerting** — priority = f(class, distance to protected asset, confidence, approach
  vector). One alert per track, updated in place. Evidence = every contributing
  detection + `raw_ref` + node trust at the time. Alert types: `intrusion`,
  `node_untrusted`, `mesh_degraded`.
- **Dashboard (Streamlit)** — node map + live tracks + prioritised alert feed with
  drill-down to evidence.
- **Mesh simulator** — synthetic nodes emitting the same signed JSON, with realistic
  noise (wind/bird false positives, a node that drops). This is the **primary demo
  path**, not a fallback. Includes adversarial modes (see §7).

## 7. Security layer (Ramiro)

Three demoable features, each mapped to a real attack:

| # | Feature | Attack it defeats |
|---|---|---|
| 1 | **Message authentication** — HMAC-SHA256, per-node key. Gateway verifies `sig`. Modes: `lenient` (accept + flag `verified:false`) during integration, `strict` (reject) for the demo. Replay handled by rejecting `seq ≤ last_seen` per node (small reorder window). | Forged messages / rogue node injected into the mesh / in-transit tampering (**outsider**). |
| 2 | **Behavioural node trust score** — independent of crypto. Per-node score in [0,1] from: neighbour agreement, message-rate anomaly vs baseline, sustained impossible reports (detections while all neighbours report `clear`), keepalive regularity. Low score → detections down-weighted in fusion, then quarantined; raises `node_untrusted` with evidence. | A physically **captured** node holding valid keys but lying (**insider**). |
| 3 | **Mesh degradation detection** — distinguish correlated silence (many nodes in a sector stop keepalives within a short window → likely jamming) from independent single-node failure. Raises `mesh_degraded` for the affected sector; the system keeps operating on reachable nodes (graceful degradation). | RF **jamming / DoS** of the mesh. |

**Roadmap (stated, not built):** AES payload encryption (hides node positions and
coverage from eavesdroppers), key rotation, secure boot on nodes, hash-chained
tamper-evident evidence log, per-node rate limiting, backend bound to `127.0.0.1`.

## 8. AI approach

Edge inference uses **pre-trained models only** — no training or fine-tuning within
48 h. Audio: YAMNet (AudioSet classes incl. aircraft). Camera: YOLO (COCO: person,
car, truck). For the demo the simulator emits detection labels directly, so the full
pipeline is demonstrable with **zero models running**. One live camera + YOLO
detection is an optional bonus if a teammate owns it.

## 9. Scope

**MVP (must run live):** 4–6 nodes (real or simulated) emitting the signed message ·
gateway verify + validate + persist · fusion → tracks on a map · prioritised, deduped
alerts with evidence · dashboard (map + feed) · one scripted scenario (intruder
crosses, track forms, one alert) · security demo (rogue node rejected + captured node
caught by trust score + jamming shown as `mesh_degraded`).

**Nice-to-have:** one real ESP node integrated end-to-end · live camera + YOLO ·
evidence playback in the dashboard · coverage / blind-spot overlay.

**Out of scope:** multiple real modalities at once · any model training · production
LoRa multi-hop · ruggedised hardware · multi-site.

## 10. Timeline

| When | Goal |
|---|---|
| **Fri eve** | Lock scope, roles, stack, repo, **message contract (incl. signing)**. Ramiro stands up the skeleton: repo, docker compose, `/health`, data models. |
| **Sat AM** | Gateway + simulator + basic fusion end-to-end (message → track). |
| **Sat PM** | Alerting + dashboard map. (Ramiro focus sprint from home, team notified.) |
| **Sat eve** | Scripted scenario end-to-end; integrate real node if available; security features. |
| **Sun 09:00** | Freeze features. Record backup demo video. |
| **Sun 10:00–12:00** | Testing, small fixes, pitch rehearsal. 12:00 hard freeze. |
| **Sun 13:00** | Demo Day (3–5 min pitch + Q&A). |

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hardware not ready Saturday | Simulator is the primary demo path; hardware is additive. |
| Late integration / message-format drift | Contract frozen Friday; git + Docker from hour one. |
| Live demo failure | Backup video recorded Sunday 09:00. |
| Signing blocks integration | Gateway `lenient` mode during integration, `strict` for the demo. |
| Scope creep | Fixed out-of-scope list; MVP is protected. |
| Dashboard exposed on venue wifi | Bind Streamlit to `127.0.0.1` in dev. |

## 12. Adversary model (for the pitch)

We assume the enemy attacks the sensor layer itself. Three attacks, three answers:
forged / rogue nodes → **signed messages** (crypto stops the outsider); a physically
captured node with valid keys → **behavioural trust scoring** (cross-checks against
neighbours, stops the insider); RF jamming → **correlated-dropout detection** turns the
attack into a `mesh_degraded` alert, and the system keeps running on the nodes it can
still reach.

## 13. Demo script

1. Map: 5 nodes covering a perimeter, all green.
2. Intruder (drone) enters NE. Node N03 (acoustic) detects.
3. N04 (seismic) agrees seconds later → fusion merges into one track, confidence rises
   to ~0.86.
4. One prioritised alert: *"Drone, NE sector, 0.86, nodes N03+N04, evidence attached"*.
5. Operator clicks → evidence trail (raw refs per node, node trust at the time).
6. **Twist 1:** inject a rogue node with no valid signature → rejected at the gate,
   shown in a side panel, feed stays clean.
7. **Twist 2:** a valid node starts reporting "vehicle" constantly with no neighbour
   agreement → trust score drops, `node_untrusted` alert, its detections stop polluting
   the picture.
8. **Twist 3:** silence a cluster of nodes → `mesh_degraded` alert for that sector,
   rest of the map still live.
9. Close: *"one coherent, evidence-grade picture — and resilient to attacks on the
   sensors themselves."*

## 14. Stack & conventions

- Python. Backend: FastAPI + uvicorn. Store: DuckDB. Dashboard: Streamlit + map
  (folium / pydeck).
- Transport from the root node: MQTT (`paho-mqtt`) or USB serial (`pyserial`) —
  decided with hardware.
- Integration: git, feature branches, `docker compose`.
- Env: Kali VM, Python via `uv`, one venv per project. `ruff` for lint. Secrets in
  `.env` (gitignored).
- `Makefile`: `run`, `dash`, `test`, `lint`.

## 15. Open questions for the team

1. Real sensor hardware for Saturday, or simulated feed?
2. Role split — nodes / on-board mesh / edge models / camera: who owns each? (Ramiro
   owns everything from the root node onward.)
3. Transport from the root node: MQTT, USB serial, or WiFi HTTP?
4. Can the node firmware add HMAC-SHA256 signing per message?
5. Reference site for the demo map (a specific port/base near Hamburg)?
6. Confirm the message JSON schema.
