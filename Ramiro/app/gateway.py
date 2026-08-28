"""FastAPI gateway — the entry point for node messages and the read API.

Flow of `/ingest`:
    NodeMessage -> validate -> look up node position -> Detection
                -> store -> fusion -> lifecycle -> tracks
                -> alerting -> store tracks & alerts -> ack
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from app.alerting import AlertingEngine
from app.config import Settings, get_settings
from app.fusion import FusionEngine
from app.models import Detection, NodeMessage, utcnow
from app.nodes import load_nodes, load_protected_asset
from app.store import Store


def create_app(
    *,
    settings: Settings | None = None,
    store: Store | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    store = store or Store(settings.db_path)
    nodes = load_nodes(settings.nodes_file)
    asset = load_protected_asset(settings.nodes_file)

    fusion = FusionEngine(settings)
    alerting = AlertingEngine(settings, protected_asset=asset)
    last_seq: dict[str, int] = {}

    app = FastAPI(title="UGS Mesh Gateway", version="0.1.0")
    app.state.store = store
    app.state.fusion = fusion
    app.state.alerting = alerting

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "nodes_configured": len(nodes)}

    @app.post("/ingest")
    def ingest(msg: NodeMessage) -> dict:
        node = nodes.get(msg.node_id)
        if node is None:
            raise HTTPException(
                status_code=422, detail=f"unknown node_id: {msg.node_id}"
            )

        # soft replay / duplicate guard (hard crypto check comes with the security layer)
        if msg.seq <= last_seq.get(msg.node_id, -1):
            return {"accepted": False, "reason": "stale-or-duplicate-seq"}
        last_seq[msg.node_id] = msg.seq

        det: Detection = Detection.from_message(msg, node)
        store.insert_detection(det)
        store.upsert_node_seen(det.node_id, det.seq, det.ts)

        fusion.ingest(det)
        fusion.update_lifecycle(det.ts)
        tracks = fusion.snapshot(now=det.ts, include_closed=True)
        for tr in tracks:
            store.upsert_track(tr)

        alerts = alerting.evaluate(
            [t for t in tracks if t.status.value == "confirmed"], now=det.ts
        )
        for al in alerts:
            store.upsert_alert(al)

        return {
            "accepted": True,
            "detection_ts": det.ts.isoformat(),
            "open_tracks": sum(1 for t in tracks if t.status.value != "closed"),
            "alerts": len(alerts),
        }

    @app.get("/nodes")
    def get_nodes() -> dict:
        return {
            "configured": [n.model_dump() for n in nodes.values()],
            "seen": store.list_nodes_seen(),
        }

    @app.get("/tracks")
    def get_tracks(include_closed: bool = False) -> list[dict]:
        return [
            t.model_dump(mode="json")
            for t in fusion.snapshot(include_closed=include_closed)
        ]

    @app.get("/alerts")
    def get_alerts() -> list[dict]:
        return [a.model_dump(mode="json") for a in alerting.snapshot()]

    @app.get("/stats")
    def stats() -> dict:
        return {
            "detections": store.detection_count(),
            "open_tracks": len(fusion.snapshot()),
            "alerts": len(alerting.snapshot()),
            "server_time": utcnow().isoformat(),
        }

    return app
