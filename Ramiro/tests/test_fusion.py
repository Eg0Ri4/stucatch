from __future__ import annotations

from datetime import timedelta

from app.config import Settings
from app.fusion import FusionEngine
from app.geo import haversine_m
from app.models import Detection, DetectionClass, Modality, TrackStatus


def _det(
    ts,
    lat,
    lon,
    node_id="N01",
    modality=Modality.acoustic,
    cls=DetectionClass.drone,
    conf=0.8,
    seq=1,
):
    return Detection(
        node_id=node_id,
        seq=seq,
        modality=modality,
        det_class=cls,
        confidence=conf,
        ts=ts,
        lat=lat,
        lon=lon,
    )


def test_geo_sanity():
    # ~111 m per 0.001 deg latitude
    d = haversine_m(53.540, 9.980, 53.541, 9.980)
    assert 100 < d < 125


def test_two_close_detections_merge_into_one_track(settings, t0):
    fe = FusionEngine(settings)
    fe.ingest(_det(t0, 53.5410, 9.9820))
    fe.ingest(_det(t0 + timedelta(seconds=3), 53.5411, 9.9821, node_id="N02"))
    tracks = fe.snapshot(now=t0 + timedelta(seconds=3))
    assert len(tracks) == 1
    assert tracks[0].detection_count == 2
    assert set(tracks[0].node_ids) == {"N01", "N02"}


def test_far_detections_make_two_tracks(settings, t0):
    fe = FusionEngine(settings)
    fe.ingest(_det(t0, 53.5410, 9.9820))
    fe.ingest(
        _det(t0 + timedelta(seconds=1), 53.5460, 9.9900, node_id="N09")
    )  # ~800 m away
    assert len(fe.snapshot(now=t0 + timedelta(seconds=1))) == 2


def test_outside_time_window_makes_new_track(settings, t0):
    fe = FusionEngine(settings)
    fe.ingest(_det(t0, 53.5410, 9.9820))
    fe.ingest(_det(t0 + timedelta(seconds=30), 53.5410, 9.9820))  # same spot, too late
    assert len(fe.snapshot(now=t0 + timedelta(seconds=30))) == 2


def test_two_modalities_confirm_track(settings, t0):
    fe = FusionEngine(settings)
    tr = fe.ingest(_det(t0, 53.5410, 9.9820, modality=Modality.acoustic))
    assert tr.status is TrackStatus.tentative
    tr = fe.ingest(
        _det(t0 + timedelta(seconds=2), 53.5410, 9.9820, modality=Modality.seismic)
    )
    assert tr.status is TrackStatus.confirmed


def test_repeat_detections_confirm_track(settings, t0):
    fe = FusionEngine(settings)
    fe.ingest(_det(t0, 53.5410, 9.9820))
    tr = fe.ingest(_det(t0 + timedelta(seconds=2), 53.5410, 9.9820))
    assert tr.status is TrackStatus.confirmed  # confirm_min_detections default = 2


def test_clear_keepalive_is_ignored(settings, t0):
    fe = FusionEngine(settings)
    assert fe.ingest(_det(t0, 53.5410, 9.9820, cls=DetectionClass.clear)) is None
    assert fe.snapshot(now=t0) == []


def test_stale_then_closed(settings, t0):
    s = Settings(track_stale_after_s=10.0, track_close_after_s=20.0)
    fe = FusionEngine(s)
    fe.ingest(_det(t0, 53.5410, 9.9820))
    fe.update_lifecycle(t0 + timedelta(seconds=12))
    assert fe.snapshot(now=t0 + timedelta(seconds=12))[0].status is TrackStatus.stale
    fe.update_lifecycle(t0 + timedelta(seconds=25))
    assert (
        fe.snapshot(now=t0 + timedelta(seconds=25), include_closed=True)[0].status
        is TrackStatus.closed
    )
    assert fe.snapshot(now=t0 + timedelta(seconds=25)) == []  # closed hidden by default


def test_confidence_decays_with_age(settings, t0):
    fe = FusionEngine(settings)
    fe.ingest(_det(t0, 53.5410, 9.9820, conf=0.9))
    fresh = fe.snapshot(now=t0)[0].confidence
    later = fe.snapshot(now=t0 + timedelta(seconds=30))[0].confidence
    assert fresh > later >= 0.0
