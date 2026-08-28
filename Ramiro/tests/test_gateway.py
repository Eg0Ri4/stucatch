from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.gateway import create_app
from app.store import Store
from tests.conftest import make_message

_NODES = {
    "nodes": [
        {"node_id": "N01", "name": "North", "lat": 53.5432, "lon": 9.9740},
        {"node_id": "N02", "name": "NE", "lat": 53.5433, "lon": 9.9800},
    ],
    "protected_asset": {"name": "asset", "lat": 53.5432, "lon": 9.9741},
}


@pytest.fixture
def client(tmp_path):
    nodes_file = tmp_path / "nodes.json"
    nodes_file.write_text(json.dumps(_NODES), encoding="utf-8")
    settings = Settings(db_path=tmp_path / "g.duckdb", nodes_file=nodes_file)
    app = create_app(settings=settings, store=Store(":memory:"))
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_ingest_happy_path(client):
    r = client.post("/ingest", json=make_message(node_id="N01", seq=1))
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] is True
    assert "detection_ts" in body


def test_ingest_unknown_node_is_422(client):
    r = client.post("/ingest", json=make_message(node_id="ZZZ"))
    assert r.status_code == 422


def test_ingest_bad_payload_is_422(client):
    r = client.post("/ingest", json={"node_id": "N01"})  # missing fields
    assert r.status_code == 422


def test_stale_seq_is_rejected_softly(client):
    assert client.post("/ingest", json=make_message(node_id="N01", seq=5)).json()[
        "accepted"
    ]
    r = client.post("/ingest", json=make_message(node_id="N01", seq=3))
    assert r.status_code == 200
    assert r.json() == {"accepted": False, "reason": "stale-or-duplicate-seq"}


def test_two_modalities_produce_confirmed_track_and_alert(client):
    client.post(
        "/ingest",
        json=make_message(
            node_id="N01", seq=1, modality="acoustic", det_class="drone", confidence=0.8
        ),
    )
    client.post(
        "/ingest",
        json=make_message(
            node_id="N01", seq=2, modality="seismic", det_class="drone", confidence=0.7
        ),
    )
    tracks = client.get("/tracks").json()
    assert len(tracks) == 1
    assert tracks[0]["status"] == "confirmed"

    alerts = client.get("/alerts").json()
    assert len(alerts) == 1
    assert alerts[0]["det_class"] == "drone"


def test_nodes_endpoint_lists_configured_and_seen(client):
    client.post("/ingest", json=make_message(node_id="N02", seq=1))
    body = client.get("/nodes").json()
    assert {n["node_id"] for n in body["configured"]} == {"N01", "N02"}
    assert body["seen"][0]["node_id"] == "N02"


def test_clear_keepalive_makes_no_track(client):
    client.post(
        "/ingest",
        json=make_message(node_id="N01", seq=1, det_class="clear", confidence=0.0),
    )
    assert client.get("/tracks").json() == []
