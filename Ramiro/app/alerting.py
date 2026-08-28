"""Alerting engine — turns confirmed tracks into deduplicated, prioritised alerts.

One alert per track (keyed by track_id), updated in place. Priority from threat
class, confidence, and — once the demo site is set — proximity to the protected
asset. Rules are first guesses (TO CALIBRATE).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from app.config import Settings
from app.geo import haversine_m
from app.models import (
    Alert,
    AlertPriority,
    DetectionClass,
    Position,
    Track,
    TrackStatus,
    utcnow,
)

_CLASS_RANK: dict[DetectionClass, int] = {
    DetectionClass.drone: 3,
    DetectionClass.vehicle: 2,
    DetectionClass.person: 2,
    DetectionClass.unknown: 1,
    DetectionClass.clear: 0,
}

_PRIORITY_ORDER = [AlertPriority.low, AlertPriority.medium, AlertPriority.high]


def _bump(priority: AlertPriority) -> AlertPriority:
    idx = min(_PRIORITY_ORDER.index(priority) + 1, len(_PRIORITY_ORDER) - 1)
    return _PRIORITY_ORDER[idx]


@dataclass
class _MutableAlert:
    alert_id: str
    track_id: str
    created: datetime
    updated: datetime
    priority: AlertPriority
    det_class: DetectionClass
    confidence: float
    lat: float
    lon: float
    node_ids: list[str]
    summary: str

    def to_model(self) -> Alert:
        return Alert(**self.__dict__)


class AlertingEngine:
    def __init__(
        self, settings: Settings, protected_asset: Position | None = None
    ) -> None:
        self.s = settings
        self.asset = protected_asset
        self._alerts: dict[str, _MutableAlert] = {}  # keyed by track_id

    def evaluate(self, tracks: list[Track], now: datetime | None = None) -> list[Alert]:
        ref = now or utcnow()
        for tr in tracks:
            if tr.status is TrackStatus.confirmed:
                self._upsert(tr, ref)
        return self.snapshot()

    def snapshot(self) -> list[Alert]:
        out = [a.to_model() for a in self._alerts.values()]
        out.sort(
            key=lambda a: (_PRIORITY_ORDER.index(a.priority), a.confidence),
            reverse=True,
        )
        return out

    # --- internals ------------------------------------------------------- #
    def _priority_for(self, tr: Track) -> AlertPriority:
        if (
            tr.confidence >= self.s.alert_high_confidence
            and _CLASS_RANK[tr.det_class] >= 3
        ):
            prio = AlertPriority.high
        elif tr.confidence >= self.s.alert_high_confidence or (
            tr.confidence >= self.s.alert_medium_confidence
            and _CLASS_RANK[tr.det_class] >= 2
        ):
            prio = AlertPriority.medium
        else:
            prio = AlertPriority.low

        if self.asset is not None:
            dist = haversine_m(tr.lat, tr.lon, self.asset.lat, self.asset.lon)
            if dist <= self.s.protected_asset_radius_m:
                prio = _bump(prio)
        return prio

    def _summary(self, tr: Track, prio: AlertPriority) -> str:
        mods = "+".join(m.value for m in tr.modalities)
        nodes = "+".join(tr.node_ids)
        return (
            f"{tr.det_class.value.upper()} — {prio.value} — conf {tr.confidence:.2f} "
            f"— nodes {nodes} ({mods}) — {tr.detection_count} detections"
        )

    def _upsert(self, tr: Track, now: datetime) -> None:
        prio = self._priority_for(tr)
        existing = self._alerts.get(tr.track_id)
        if existing is None:
            self._alerts[tr.track_id] = _MutableAlert(
                alert_id=f"A-{uuid.uuid4().hex[:8]}",
                track_id=tr.track_id,
                created=now,
                updated=now,
                priority=prio,
                det_class=tr.det_class,
                confidence=tr.confidence,
                lat=tr.lat,
                lon=tr.lon,
                node_ids=list(tr.node_ids),
                summary="",
            )
            existing = self._alerts[tr.track_id]
        else:
            existing.updated = now
            existing.priority = prio
            existing.det_class = tr.det_class
            existing.confidence = tr.confidence
            existing.lat, existing.lon = tr.lat, tr.lon
            existing.node_ids = list(tr.node_ids)
        existing.summary = self._summary(tr, prio)
