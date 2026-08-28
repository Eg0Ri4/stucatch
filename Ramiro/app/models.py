"""Data models — the single source of truth for the message contract (v0).

A node emits a `NodeMessage` over the mesh. The gateway enriches it with a server
timestamp and the node's position (from `config/nodes.json`) to produce a
`Detection`. Fusion turns detections into `Track`s; alerting turns tracks into
`Alert`s.

Contract v0 is provisional — confirm with the team (kickoff Q14). Changing it is
a change in THIS file only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class Modality(StrEnum):
    acoustic = "acoustic"
    seismic = "seismic"
    pir = "pir"
    magnetometer = "magnetometer"
    rf = "rf"
    camera = "camera"


class DetectionClass(StrEnum):
    drone = "drone"
    person = "person"
    vehicle = "vehicle"
    unknown = "unknown"
    clear = "clear"  # keepalive / all-clear — not a track input


class TrackStatus(StrEnum):
    tentative = "tentative"
    confirmed = "confirmed"
    stale = "stale"
    closed = "closed"


class AlertPriority(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"


def utcnow() -> datetime:
    return datetime.now(UTC)


# --------------------------------------------------------------------------- #
# What a node sends                                                            #
# --------------------------------------------------------------------------- #
class DetectionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    det_class: DetectionClass = Field(alias="class")
    confidence: float = Field(ge=0.0, le=1.0)


class NodeMessage(BaseModel):
    """Exactly the JSON a node emits over the mesh (contract v0)."""

    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(min_length=1, max_length=32)
    seq: int = Field(ge=0)
    modality: Modality
    detection: DetectionPayload
    raw_ref: str | None = Field(default=None, max_length=256)


# --------------------------------------------------------------------------- #
# Node registry (config/nodes.json)                                            #
# --------------------------------------------------------------------------- #
class Position(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)


class NodeInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str
    name: str
    pos: Position


# --------------------------------------------------------------------------- #
# Enriched detection (gateway output)                                          #
# --------------------------------------------------------------------------- #
class Detection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str
    seq: int
    modality: Modality
    det_class: DetectionClass
    confidence: float
    raw_ref: str | None = None
    ts: datetime  # server arrival time, UTC
    lat: float
    lon: float

    @classmethod
    def from_message(
        cls, msg: NodeMessage, node: NodeInfo, ts: datetime | None = None
    ) -> Detection:
        return cls(
            node_id=msg.node_id,
            seq=msg.seq,
            modality=msg.modality,
            det_class=msg.detection.det_class,
            confidence=msg.detection.confidence,
            raw_ref=msg.raw_ref,
            ts=ts or utcnow(),
            lat=node.pos.lat,
            lon=node.pos.lon,
        )


# --------------------------------------------------------------------------- #
# Fusion / alerting output                                                     #
# --------------------------------------------------------------------------- #
class Track(BaseModel):
    model_config = ConfigDict(extra="forbid")

    track_id: str
    status: TrackStatus
    det_class: DetectionClass
    confidence: float
    first_seen: datetime
    last_seen: datetime
    lat: float
    lon: float
    node_ids: list[str]
    modalities: list[Modality]
    detection_count: int


class Alert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alert_id: str
    track_id: str
    priority: AlertPriority
    det_class: DetectionClass
    confidence: float
    created: datetime
    updated: datetime
    lat: float
    lon: float
    node_ids: list[str]
    summary: str
