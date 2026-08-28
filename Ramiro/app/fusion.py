"""Fusion engine — groups raw detections into tracks.

Deterministic, no ML. A detection either joins the nearest open track within a
time+distance window, or opens a new one. Track confidence is the strongest
recent detection, boosted when several distinct modalities agree, and decayed by
time since the last update. Lifecycle: tentative -> confirmed -> stale -> closed.

Thresholds live in `Settings` and are first guesses (TO CALIBRATE).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.config import Settings
from app.geo import haversine_m
from app.models import Detection, DetectionClass, Modality, Track, TrackStatus


@dataclass
class _MutableTrack:
    track_id: str
    det_class: DetectionClass
    first_seen: datetime
    last_seen: datetime
    lat: float
    lon: float
    status: TrackStatus = TrackStatus.tentative
    detection_count: int = 0
    _class_votes: dict[DetectionClass, float] = field(default_factory=dict)
    _modality_conf: dict[Modality, float] = field(default_factory=dict)
    _node_ids: list[str] = field(default_factory=list)

    def add(self, det: Detection) -> None:
        self.last_seen = det.ts
        self.lat, self.lon = det.lat, det.lon
        self.detection_count += 1
        self._class_votes[det.det_class] = (
            self._class_votes.get(det.det_class, 0.0) + det.confidence
        )
        self._modality_conf[det.modality] = max(
            self._modality_conf.get(det.modality, 0.0), det.confidence
        )
        if det.node_id not in self._node_ids:
            self._node_ids.append(det.node_id)
        self.det_class = max(self._class_votes.items(), key=lambda kv: kv[1])[0]

    def base_confidence(self, settings: Settings) -> float:
        if not self._modality_conf:
            return 0.0
        strongest = max(self._modality_conf.values())
        boost = settings.modality_confidence_boost * (len(self._modality_conf) - 1)
        return min(1.0, strongest + boost)

    def effective_confidence(self, now: datetime, settings: Settings) -> float:
        conf = self.base_confidence(settings)
        age = (now - self.last_seen).total_seconds()
        if age <= 0:
            return conf
        decay = max(0.0, 1.0 - age / settings.confidence_decay_after_s)
        return round(conf * decay, 4)

    def to_model(self, now: datetime, settings: Settings) -> Track:
        return Track(
            track_id=self.track_id,
            status=self.status,
            det_class=self.det_class,
            confidence=self.effective_confidence(now, settings),
            first_seen=self.first_seen,
            last_seen=self.last_seen,
            lat=self.lat,
            lon=self.lon,
            node_ids=list(self._node_ids),
            modalities=list(self._modality_conf.keys()),
            detection_count=self.detection_count,
        )


class FusionEngine:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self._tracks: dict[str, _MutableTrack] = {}

    def ingest(self, det: Detection) -> _MutableTrack | None:
        """Associate a detection. `clear` keepalives are ignored (return None)."""
        if det.det_class is DetectionClass.clear:
            return None

        candidate = self._nearest_open_track(det)
        if candidate is None:
            candidate = _MutableTrack(
                track_id=f"T-{uuid.uuid4().hex[:8]}",
                det_class=det.det_class,
                first_seen=det.ts,
                last_seen=det.ts,
                lat=det.lat,
                lon=det.lon,
            )
            self._tracks[candidate.track_id] = candidate

        candidate.add(det)
        self._apply_promotion(candidate)
        return candidate

    def update_lifecycle(self, now: datetime) -> None:
        for tr in self._tracks.values():
            if tr.status is TrackStatus.closed:
                continue
            age = (now - tr.last_seen).total_seconds()
            if age > self.s.track_close_after_s:
                tr.status = TrackStatus.closed
            elif age > self.s.track_stale_after_s:
                tr.status = TrackStatus.stale
            elif tr.status is TrackStatus.stale:
                # a stale track that got no new detections stays stale until closed
                pass

    def snapshot(
        self, now: datetime | None = None, include_closed: bool = False
    ) -> list[Track]:
        ref = now or self._latest_ts()
        out = [
            tr.to_model(ref, self.s)
            for tr in self._tracks.values()
            if include_closed or tr.status is not TrackStatus.closed
        ]
        out.sort(key=lambda t: t.last_seen, reverse=True)
        return out

    # --- internals ------------------------------------------------------- #
    def _nearest_open_track(self, det: Detection) -> _MutableTrack | None:
        best: _MutableTrack | None = None
        best_dist = float("inf")
        for tr in self._tracks.values():
            if tr.status in (TrackStatus.closed, TrackStatus.stale):
                continue
            dt = (det.ts - tr.last_seen).total_seconds()
            if dt < 0 or dt > self.s.assoc_time_window_s:
                continue
            dist = haversine_m(det.lat, det.lon, tr.lat, tr.lon)
            if dist <= self.s.assoc_distance_m and dist < best_dist:
                best, best_dist = tr, dist
        return best

    def _apply_promotion(self, tr: _MutableTrack) -> None:
        if tr.status is not TrackStatus.tentative:
            return
        enough_hits = tr.detection_count >= self.s.track_confirm_min_detections
        multi_modality = len(tr._modality_conf) >= 2
        if enough_hits or multi_modality:
            tr.status = TrackStatus.confirmed

    def _latest_ts(self) -> datetime | None:
        if not self._tracks:
            return None
        return max(tr.last_seen for tr in self._tracks.values())
