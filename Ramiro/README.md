# UGS Mesh

A low-cost mesh of unattended ground sensors (UGS) for perimeter defence:
ESP32-C3 nodes on a self-forming **painlessMesh**, a Raspberry Pi base that fuses
every node's reports into **one coherent, evidence-grade picture** with prioritised
alerts.

Built for the European Defense Tech Hackathon (Hamburg, 28–30 Aug 2026),
challenge 04 — *Protecting a Critical Site From Small Drones* (own-challenge
variant).

## Layout

```
app/            Pi-side software (Python)
  gateway.py      FastAPI: /ingest /health /nodes /tracks /alerts /stats
  models.py       message contract — single source of truth
  fusion.py       detections -> tracks (deterministic, no ML)
  alerting.py     confirmed tracks -> deduplicated, prioritised alerts
  store.py        DuckDB persistence (the evidence trail)
  serial_bridge.py  root ESP32 serial -> gateway  (also --stdin for testing)
  dashboard.py    Streamlit operator view (offline-safe)
  config.py       tunables; fusion/alert thresholds marked TO CALIBRATE
sim/            mesh simulator — synthetic node feed, scripted intruder scenario
firmware/       painlessMesh sketches: sensor_node + root_node (+ platformio.ini)
config/nodes.json   node_id -> {name, lat, lon}  (placeholder site — replace)
tests/          pytest (44 tests)
docs/           project brief, kickoff questions, mesh guide, encryption research
```

## Run

```bash
# one-time: create the venv and install deps
uv venv && uv pip install -r requirements.txt

make run      # gateway   -> http://127.0.0.1:8000
make dash     # dashboard  -> http://127.0.0.1:8501   (second terminal)
make sim      # drive traffic (~3 min scripted scenario)  (third terminal)
make test     # 44 tests
make lint     # ruff
```

No hardware needed to build or demo the Pi side — the simulator produces the same
messages the real nodes will. When the mesh is up:

```bash
uv run python -m app.serial_bridge --port /dev/ttyACM0 --gateway http://127.0.0.1:8000
```

## Message contract

A node broadcasts:

```json
{"node_id":"N03","seq":1421,"modality":"acoustic","detection":{"class":"drone","confidence":0.82}}
```

`modality`: acoustic | seismic | pir | magnetometer | rf | camera
`class`: drone | person | vehicle | unknown | clear   (`clear` = keepalive)
The gateway adds `ts` (arrival time) and `lat`/`lon` (from `config/nodes.json`).
`seq` is per-node and must strictly increase — the sketch persists it to NVS;
stale/duplicate `seq` is rejected.

## Work split

| Area | Owner |
|---|---|
| Physical nodes: boards, sensors, wiring, flashing | hardware team |
| painlessMesh firmware (`firmware/`) | drafted here; hardware team flashes & tests |
| Pi-side software (`app/`, `sim/`) + dashboard | software |

Boundary: once data leaves the root node over serial, it is software.

## Docs

- [`docs/overview.md`](docs/overview.md) — what the Pi software does, mapped to the challenge
- [`docs/kickoff-questions.md`](docs/kickoff-questions.md) — decisions made / still open
- [`docs/painlessmesh-guide.md`](docs/painlessmesh-guide.md) — mesh setup, sketches, flashing, gotchas
- [`docs/project-brief.md`](docs/project-brief.md) — full project brief ([DE](docs/project-brief.de.md))
- [`docs/encryption-esp32c3.md`](docs/encryption-esp32c3.md) — AES-256 on ESP32-C3 (later step)

## Status / not done yet

Fusion & alert thresholds are first guesses (`app/config.py`, marked `TO CALIBRATE`).
No AI / no ML — detection labels are rule-based or simulated. Security layer
(signing, encryption, node-trust, jamming detection) is a separate later step.
Real map tiles pending venue internet + a chosen site.
