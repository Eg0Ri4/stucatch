# Pi-side software — what is built (v0)

**Team:** UGS Mesh · commit on `main`

## In one line

Everything from *"a node message arrives"* to *"the operator sees one prioritised,
evidence-backed alert on screen"* — plus a simulator so it all runs without
hardware. 42 automated tests, lint/format clean.

---

## Capabilities delivered

| # | Capability | What it does | Where | See it |
|---|---|---|---|---|
| 1 | **Ingest & validation** | Accepts node messages at `POST /ingest`. Rejects malformed payloads, unknown `node_id`, and stale/duplicate `seq`. | `app/gateway.py`, `app/models.py` | `curl -XPOST .../ingest` |
| 2 | **Node registry & positioning** | Maps `node_id` → `{name, lat, lon}`. Enriches every detection with position + server arrival time (nodes have no clock — kickoff Q13). | `app/nodes.py`, `config/nodes.json` | `GET /nodes` |
| 3 | **Evidence store** | Every detection, node-status, track and alert persisted to DuckDB. Queryable by time window = the evidence trail. | `app/store.py` | `data/ugs.duckdb` |
| 4 | **Sensor fusion** | Groups detections from many nodes/sensors into **one track per object** (time + distance association). Cross-modality confidence: 2+ agreeing sensor types raise it. Track lifecycle `tentative → confirmed → stale → closed`. This is the challenge's *"one coherent picture, not a wall of alarms"*. | `app/fusion.py` | `GET /tracks` |
| 5 | **False-positive suppression** | A single fleeting single-node hit stays `tentative` and **never alerts**. Only corroboration (repeat hits, or 2+ modalities) promotes to `confirmed`. Confidence also decays with age. Challenge's *"reject birds and clutter"*. | `app/fusion.py` (promotion rules) | simulator injects wind/bird noise; it does not surface as alerts |
| 6 | **Threat alerting** | One **deduplicated** alert per confirmed track, updated in place. Priority from threat class + confidence + (once the site is set) proximity to the protected asset. | `app/alerting.py` | `GET /alerts` |
| 7 | **Evidence-grade output** | Each alert carries: contributing nodes, modalities, detection count, confidence, position, created/updated times, human-readable summary. | `app/alerting.py` | alert `summary` field |
| 8 | **Operator dashboard** | Live view: node/track scatter map, alert feed sorted by priority, drill-down tables, running counters. No map tiles → works offline at the venue. | `app/dashboard.py` | `http://127.0.0.1:8501` |
| 9 | **Read API** | `/health` `/nodes` `/tracks` `/alerts` `/stats` for the dashboard and for integration/debugging. | `app/gateway.py` | browser / curl |
| 10 | **Mesh simulator** | Synthetic node feed: periodic keepalives, a scripted intruder path, scattered false positives. Deterministic per seed. **The primary demo path** — hardware-independent. | `sim/simulator.py`, `sim/scenarios.py` | `make sim` |
| 11 | **Hardware bridge (stub)** | Reads newline-delimited JSON from the root ESP32 over USB serial and forwards each line to `/ingest`. Ready for when the mesh is up. | `app/serial_bridge.py` | `python -m app.serial_bridge --port /dev/ttyUSB0` |
| 12 | **Config & calibration surface** | Every fusion/alert threshold in one file, override by env var, each marked `TO CALIBRATE`. | `app/config.py` | — |
| 13 | **Packaging & quality** | 42 pytest tests, `ruff` lint + format, `Dockerfile` + `compose.yaml` for team parity, `Makefile` targets. | `tests/`, `pyproject.toml` | `make test` |

---

## The request → alert path

1. A node (real or simulated) emits
   `{"node_id":"N03","seq":1421,"modality":"acoustic","detection":{"class":"drone","confidence":0.82}}`.
2. It reaches `POST /ingest`. The gateway validates it, checks `seq` is newer than
   the last one from that node, looks up N03's position, and stamps arrival time.
3. The enriched **Detection** is written to DuckDB.
4. **Fusion**: if a nearby open track was updated in the last few seconds, the
   detection joins it; otherwise a new track opens. Confidence is recomputed;
   agreeing modalities boost it.
5. **Promotion**: enough hits or 2+ modalities → the track becomes `confirmed`.
6. **Alerting**: the confirmed track produces (or updates) one alert, prioritised,
   with the full evidence list.
7. Track and alert are persisted.
8. The **dashboard** polls `/tracks` and `/alerts` and redraws — the operator sees
   the moving track and the alert.

---

## Not done yet — on purpose

| Item | Blocked on |
|---|---|
| Node firmware (painlessMesh mesh + `sendData()` + root serial output) | kickoff Q6/Q7/Q8/Q11 |
| Threshold calibration (association distance/time, confidence, priority cut-offs) | real sensor behaviour (Q17) |
| Security layer — message signing, AES-256-GCM, per-node trust scoring, jamming detection | separate step; see `docs/encryption-esp32c3.md` |
| Real map with tiles | venue internet (Q22) + demo site (Q23) |
| Multi-node position estimation (triangulating the intruder instead of using node positions) | future work; noted in `README.md` |

---

## Maps to the challenge criteria

| Challenge asks for | Covered by |
|---|---|
| Layered **detect → classify → alert** | ingest (1) → fusion/classify (4) → alerting (6) |
| **Fuse sensors into one coherent picture** | fusion engine (4) — one track per object, not per sensor |
| **Reject birds and clutter** | false-positive suppression (5) |
| **Evidence-grade output** (what, where, confidence, for tasking a patrol) | evidence store (3) + alert payload (7) |
| **Affordable / deployable** | ESP32 nodes + a Raspberry Pi; the whole Pi stack is ~1500 lines of Python |
| **How the adversary attacks it** | designed for — the security layer (signing / trust score / jamming detection) is scoped in `08` |

---

## Run it

```bash
make run     # gateway     -> http://127.0.0.1:8000
make dash    # dashboard    -> http://127.0.0.1:8501   (second terminal)
make sim     # drive traffic (≈3 min scripted scenario) (third terminal)
make test    # 42 tests
```
