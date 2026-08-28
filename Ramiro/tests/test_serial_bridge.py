"""The bridge must accept exactly the strings the painlessMesh root sketch emits."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.config import Settings
from app.gateway import create_app
from app.serial_bridge import forward_lines
from app.store import Store

# sample lines as the root ESP32 will println() them (compact, newline-terminated)
_SKETCH_OUTPUT = [
    '{"node_id":"N01","seq":1,"modality":"pir","detection":{"class":"clear","confidence":0}}',
    '{"node_id":"N02","seq":1,"modality":"acoustic","detection":{"class":"drone","confidence":0.81}}',
    '{"node_id":"N02","seq":2,"modality":"seismic","detection":{"class":"drone","confidence":0.66}}',
    "",  # blank line between frames — must be tolerated
    "MESH: new connection nodeId=1911...",  # non-JSON status line — must be skipped
    '{"node_id":"N02","seq":2,"modality":"acoustic","detection":{"class":"drone","confidence":0.7}}',  # stale seq
]


def _client_post(client: TestClient):
    def post(payload):
        r = client.post("/ingest", json=payload)
        return r.status_code, r.text

    return post


def _make_client(tmp_path):
    nodes_file = tmp_path / "nodes.json"
    nodes_file.write_text(
        json.dumps(
            {
                "nodes": [
                    {"node_id": "N01", "name": "N01", "lat": 53.5432, "lon": 9.9740},
                    {"node_id": "N02", "name": "N02", "lat": 53.5433, "lon": 9.9800},
                ]
            }
        ),
        encoding="utf-8",
    )
    settings = Settings(db_path=tmp_path / "b.duckdb", nodes_file=nodes_file)
    return TestClient(create_app(settings=settings, store=Store(":memory:")))


def test_bridge_forwards_sketch_output(tmp_path):
    with _make_client(tmp_path) as client:
        summary = forward_lines(iter(_SKETCH_OUTPUT), _client_post(client))

    assert summary["bad"] == 1  # the MESH status line
    assert summary["sent"] == 4  # 4 JSON frames posted (blank line not counted)
    assert summary["accepted"] == 3  # last frame is a stale seq -> rejected
    assert summary["rejected"] == 1

    with _make_client(tmp_path) as client:
        forward_lines(iter(_SKETCH_OUTPUT), _client_post(client))
        alerts = client.get("/alerts").json()
        assert any(a["det_class"] == "drone" for a in alerts)


def test_bridge_survives_unknown_node(tmp_path):
    with _make_client(tmp_path) as client:
        summary = forward_lines(
            iter(
                [
                    '{"node_id":"ZZZ","seq":1,"modality":"rf","detection":{"class":"drone","confidence":0.5}}'
                ]
            ),
            _client_post(client),
        )
    assert summary["sent"] == 1
    assert summary["rejected"] == 1  # 422, bridge keeps going
