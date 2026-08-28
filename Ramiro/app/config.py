"""Central configuration.

Values come from environment variables with sane defaults, so there is no extra
dependency. Anything a teammate might want to tune lives here, not scattered in
the code. Fusion / alerting thresholds are marked TO CALIBRATE — they are first
guesses until we know the real sensors.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    # --- storage ---
    db_path: Path = ROOT / "data" / "ugs.duckdb"
    nodes_file: Path = ROOT / "config" / "nodes.json"

    # --- fusion: how detections are grouped into one track --- (TO CALIBRATE)
    assoc_time_window_s: float = (
        8.0  # a detection joins a track if within this of its last update
    )
    assoc_distance_m: float = 150.0  # ...and within this distance
    modality_confidence_boost: float = 0.1  # per extra distinct modality that agrees
    track_confirm_min_detections: int = (
        2  # detections needed to promote tentative -> confirmed
    )
    track_stale_after_s: float = 30.0  # no update for this long -> stale
    track_close_after_s: float = 120.0  # no update for this long -> closed
    confidence_decay_after_s: float = (
        60.0  # confidence fades linearly to 0 over this window
    )

    # --- alerting --- (TO CALIBRATE)
    alert_high_confidence: float = 0.75
    alert_medium_confidence: float = 0.55
    protected_asset_lat: float | None = None  # set once the demo site (Q23) is decided
    protected_asset_lon: float | None = None
    protected_asset_radius_m: float = 500.0  # inside this, priority is bumped one level

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            db_path=_env_path("UGS_DB_PATH", cls.db_path),
            nodes_file=_env_path("UGS_NODES_FILE", cls.nodes_file),
            assoc_time_window_s=_env_float(
                "UGS_ASSOC_TIME_WINDOW_S", cls.assoc_time_window_s
            ),
            assoc_distance_m=_env_float("UGS_ASSOC_DISTANCE_M", cls.assoc_distance_m),
            modality_confidence_boost=_env_float(
                "UGS_MODALITY_CONFIDENCE_BOOST", cls.modality_confidence_boost
            ),
            track_confirm_min_detections=_env_int(
                "UGS_TRACK_CONFIRM_MIN_DETECTIONS", cls.track_confirm_min_detections
            ),
            track_stale_after_s=_env_float(
                "UGS_TRACK_STALE_AFTER_S", cls.track_stale_after_s
            ),
            track_close_after_s=_env_float(
                "UGS_TRACK_CLOSE_AFTER_S", cls.track_close_after_s
            ),
            confidence_decay_after_s=_env_float(
                "UGS_CONFIDENCE_DECAY_AFTER_S", cls.confidence_decay_after_s
            ),
            alert_high_confidence=_env_float(
                "UGS_ALERT_HIGH_CONFIDENCE", cls.alert_high_confidence
            ),
            alert_medium_confidence=_env_float(
                "UGS_ALERT_MEDIUM_CONFIDENCE", cls.alert_medium_confidence
            ),
        )


@lru_cache
def get_settings() -> Settings:
    return Settings.from_env()
