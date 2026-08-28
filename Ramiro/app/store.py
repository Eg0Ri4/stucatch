"""Persistence layer over DuckDB.

Thin and explicit: one connection, one lock (DuckDB connections are not meant to
be hammered from many threads, and FastAPI runs sync handlers in a threadpool).
Lists are stored as JSON text for portability.
"""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from app.models import Alert, Detection, Track

_SCHEMA = """
CREATE TABLE IF NOT EXISTS detections (
    node_id     VARCHAR,
    seq         BIGINT,
    modality    VARCHAR,
    det_class   VARCHAR,
    confidence  DOUBLE,
    raw_ref     VARCHAR,
    ts          TIMESTAMP,
    lat         DOUBLE,
    lon         DOUBLE
);
CREATE TABLE IF NOT EXISTS nodes_seen (
    node_id   VARCHAR PRIMARY KEY,
    last_seq  BIGINT,
    last_ts   TIMESTAMP,
    msg_count BIGINT
);
CREATE TABLE IF NOT EXISTS tracks (
    track_id        VARCHAR PRIMARY KEY,
    status          VARCHAR,
    det_class       VARCHAR,
    confidence      DOUBLE,
    first_seen      TIMESTAMP,
    last_seen       TIMESTAMP,
    lat             DOUBLE,
    lon             DOUBLE,
    node_ids        VARCHAR,
    modalities      VARCHAR,
    detection_count BIGINT
);
CREATE TABLE IF NOT EXISTS alerts (
    alert_id   VARCHAR PRIMARY KEY,
    track_id   VARCHAR,
    priority   VARCHAR,
    det_class  VARCHAR,
    confidence DOUBLE,
    created    TIMESTAMP,
    updated    TIMESTAMP,
    lat        DOUBLE,
    lon        DOUBLE,
    node_ids   VARCHAR,
    summary    VARCHAR
);
"""


def _naive_utc(dt: datetime) -> datetime:
    """DuckDB TIMESTAMP is tz-naive; store everything as naive UTC."""
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _aware_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class Store:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = duckdb.connect(self.path)
        for stmt in filter(None, (s.strip() for s in _SCHEMA.split(";"))):
            self._conn.execute(stmt)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- writes ------------------------------------------------------------- #
    def insert_detection(self, det: Detection) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO detections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    det.node_id,
                    det.seq,
                    det.modality.value,
                    det.det_class.value,
                    det.confidence,
                    det.raw_ref,
                    _naive_utc(det.ts),
                    det.lat,
                    det.lon,
                ],
            )

    def upsert_node_seen(self, node_id: str, seq: int, ts: datetime) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO nodes_seen VALUES (?, ?, ?, 1)
                ON CONFLICT (node_id) DO UPDATE SET
                    last_seq  = excluded.last_seq,
                    last_ts   = excluded.last_ts,
                    msg_count = nodes_seen.msg_count + 1
                """,
                [node_id, seq, _naive_utc(ts)],
            )

    def upsert_track(self, tr: Track) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (track_id) DO UPDATE SET
                    status = excluded.status,
                    det_class = excluded.det_class,
                    confidence = excluded.confidence,
                    last_seen = excluded.last_seen,
                    lat = excluded.lat,
                    lon = excluded.lon,
                    node_ids = excluded.node_ids,
                    modalities = excluded.modalities,
                    detection_count = excluded.detection_count
                """,
                [
                    tr.track_id,
                    tr.status.value,
                    tr.det_class.value,
                    tr.confidence,
                    _naive_utc(tr.first_seen),
                    _naive_utc(tr.last_seen),
                    tr.lat,
                    tr.lon,
                    json.dumps(tr.node_ids),
                    json.dumps([m.value for m in tr.modalities]),
                    tr.detection_count,
                ],
            )

    def upsert_alert(self, al: Alert) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO alerts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (alert_id) DO UPDATE SET
                    priority = excluded.priority,
                    confidence = excluded.confidence,
                    updated = excluded.updated,
                    lat = excluded.lat,
                    lon = excluded.lon,
                    node_ids = excluded.node_ids,
                    summary = excluded.summary
                """,
                [
                    al.alert_id,
                    al.track_id,
                    al.priority.value,
                    al.det_class.value,
                    al.confidence,
                    _naive_utc(al.created),
                    _naive_utc(al.updated),
                    al.lat,
                    al.lon,
                    json.dumps(al.node_ids),
                    al.summary,
                ],
            )

    # --- reads ------------------------------------------------------------- #
    def recent_detections(self, since: datetime) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT node_id, seq, modality, det_class, confidence, raw_ref, ts, lat, lon
                FROM detections WHERE ts >= ? ORDER BY ts
                """,
                [_naive_utc(since)],
            ).fetchall()
        cols = [
            "node_id",
            "seq",
            "modality",
            "det_class",
            "confidence",
            "raw_ref",
            "ts",
            "lat",
            "lon",
        ]
        out = []
        for r in rows:
            d = dict(zip(cols, r, strict=True))
            d["ts"] = _aware_utc(d["ts"])
            out.append(d)
        return out

    def detection_count(self) -> int:
        with self._lock:
            return int(
                self._conn.execute("SELECT count(*) FROM detections").fetchone()[0]
            )

    def list_nodes_seen(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT node_id, last_seq, last_ts, msg_count FROM nodes_seen ORDER BY node_id"
            ).fetchall()
        out = []
        for node_id, last_seq, last_ts, msg_count in rows:
            out.append(
                {
                    "node_id": node_id,
                    "last_seq": last_seq,
                    "last_ts": _aware_utc(last_ts) if last_ts else None,
                    "msg_count": msg_count,
                }
            )
        return out
