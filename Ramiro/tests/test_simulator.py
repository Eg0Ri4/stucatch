from __future__ import annotations

from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from app.config import Settings
from app.gateway import create_app
from app.models import DetectionClass, NodeInfo, NodeMessage, Position
from app.store import Store
from sim.scenarios import INTRUDER_CROSSING, QUIET, Intruder, Scenario, Waypoint
from sim.simulator import generate_events, run

# compact scenario for the end-to-end test — same shape, ~10x fewer messages
_COMPACT = Scenario(
    name="compact",
    duration_s=70.0,
    keepalive_interval_s=15.0,
    detect_prob_in_range=0.95,
    intruders=[
        Intruder(
            name="drone-1",
            true_class=DetectionClass.drone,
            path=[
                Waypoint(t=15.0, lat=53.5440, lon=9.9780),
                Waypoint(t=45.0, lat=53.5433, lon=9.9800),
                Waypoint(t=65.0, lat=53.5412, lon=9.9818),
            ],
        )
    ],
)

_ADAPTER = TypeAdapter(NodeMessage)


def _nodes():
    raw = {
        "N01": (53.5432, 9.9740),
        "N02": (53.5433, 9.9800),
        "N03": (53.5410, 9.9820),
    }
    return {
        nid: NodeInfo(node_id=nid, name=nid, pos=Position(lat=la, lon=lo))
        for nid, (la, lo) in raw.items()
    }


def test_events_are_valid_messages_and_seq_is_monotonic():
    nodes = _nodes()
    last_seq: dict[str, int] = {}
    count = 0
    for _vt, msg in generate_events(INTRUDER_CROSSING, nodes, seed=1):
        parsed = _ADAPTER.validate_python(msg)  # raises on bad shape
        assert parsed.seq > last_seq.get(parsed.node_id, -1)
        last_seq[parsed.node_id] = parsed.seq
        count += 1
    assert count > 50  # keepalives alone over 180 s across 3 nodes


def test_intruder_scenario_produces_real_detections():
    nodes = _nodes()
    classes = {
        _ADAPTER.validate_python(m).detection.det_class
        for _t, m in generate_events(INTRUDER_CROSSING, nodes, seed=1)
    }
    assert DetectionClass.drone in classes


def test_quiet_scenario_has_no_intruder_class():
    nodes = _nodes()
    classes = {
        _ADAPTER.validate_python(m).detection.det_class
        for _t, m in generate_events(QUIET, nodes, seed=1)
    }
    assert DetectionClass.drone not in classes
    assert DetectionClass.clear in classes


def test_generator_is_deterministic_for_a_seed():
    nodes = _nodes()
    a = list(generate_events(INTRUDER_CROSSING, nodes, seed=7))
    b = list(generate_events(INTRUDER_CROSSING, nodes, seed=7))
    assert a == b


def test_run_against_gateway_end_to_end(tmp_path):
    import json as _json

    nodes_file = tmp_path / "nodes.json"
    nodes_file.write_text(
        _json.dumps(
            {
                "nodes": [
                    {"node_id": "N01", "name": "N01", "lat": 53.5432, "lon": 9.9740},
                    {"node_id": "N02", "name": "N02", "lat": 53.5433, "lon": 9.9800},
                    {"node_id": "N03", "name": "N03", "lat": 53.5410, "lon": 9.9820},
                ]
            }
        ),
        encoding="utf-8",
    )
    settings = Settings(db_path=tmp_path / "s.duckdb", nodes_file=nodes_file)
    app = create_app(settings=settings, store=Store(":memory:"))

    with TestClient(app) as client:
        summary = {"sent": 0, "accepted": 0}
        for _vt, msg in generate_events(_COMPACT, _nodes(), seed=3):
            r = client.post("/ingest", json=msg)
            summary["sent"] += 1
            if r.json().get("accepted"):
                summary["accepted"] += 1
        assert summary["accepted"] == summary["sent"]  # monotonic seq -> all accepted
        alerts = client.get("/alerts").json()
        assert len(alerts) >= 1  # the drone crossing should raise at least one alert


def test_run_fast_print_only_no_network(capsys):
    summary = run(
        gateway=None, scenario=QUIET, nodes=_nodes(), seed=0, fast=True, do_print=True
    )
    assert summary == {"sent": 0, "accepted": 0, "rejected": 0}
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) > 10
