from __future__ import annotations

from datetime import timedelta

from app.models import (
    Alert,
    AlertPriority,
    Detection,
    DetectionClass,
    Modality,
    Track,
    TrackStatus,
)


def _det(node_id, ts, seq=1, cls=DetectionClass.drone, conf=0.8):
    return Detection(
        node_id=node_id,
        seq=seq,
        modality=Modality.acoustic,
        det_class=cls,
        confidence=conf,
        ts=ts,
        lat=53.54,
        lon=9.98,
    )


def test_detection_roundtrip_and_time_filter(store, t0):
    store.insert_detection(_det("N01", t0))
    store.insert_detection(_det("N02", t0 + timedelta(seconds=30)))
    assert store.detection_count() == 2

    recent = store.recent_detections(since=t0 + timedelta(seconds=10))
    assert [r["node_id"] for r in recent] == ["N02"]
    assert recent[0]["ts"].tzinfo is not None  # comes back tz-aware UTC


def test_nodes_seen_upsert_counts(store, t0):
    store.upsert_node_seen("N01", 1, t0)
    store.upsert_node_seen("N01", 2, t0 + timedelta(seconds=5))
    seen = store.list_nodes_seen()
    assert len(seen) == 1
    assert seen[0]["last_seq"] == 2
    assert seen[0]["msg_count"] == 2


def test_track_upsert_is_idempotent(store, t0):
    tr = Track(
        track_id="T1",
        status=TrackStatus.tentative,
        det_class=DetectionClass.drone,
        confidence=0.6,
        first_seen=t0,
        last_seen=t0,
        lat=53.54,
        lon=9.98,
        node_ids=["N01"],
        modalities=[Modality.acoustic],
        detection_count=1,
    )
    store.upsert_track(tr)
    tr2 = tr.model_copy(update={"status": TrackStatus.confirmed, "detection_count": 3})
    store.upsert_track(tr2)
    rows = store._conn.execute("SELECT status, detection_count FROM tracks").fetchall()
    assert rows == [("confirmed", 3)]


def test_alert_upsert_is_idempotent(store, t0):
    al = Alert(
        alert_id="A1",
        track_id="T1",
        priority=AlertPriority.medium,
        det_class=DetectionClass.drone,
        confidence=0.6,
        created=t0,
        updated=t0,
        lat=53.54,
        lon=9.98,
        node_ids=["N01"],
        summary="x",
    )
    store.upsert_alert(al)
    store.upsert_alert(
        al.model_copy(update={"priority": AlertPriority.high, "summary": "y"})
    )
    rows = store._conn.execute("SELECT priority, summary FROM alerts").fetchall()
    assert rows == [("high", "y")]
