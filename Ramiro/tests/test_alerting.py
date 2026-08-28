from __future__ import annotations

from datetime import timedelta

from app.alerting import AlertingEngine
from app.models import (
    AlertPriority,
    DetectionClass,
    Modality,
    Position,
    Track,
    TrackStatus,
)


def _track(
    status=TrackStatus.confirmed,
    cls=DetectionClass.drone,
    conf=0.85,
    track_id="T1",
    lat=53.5410,
    lon=9.9820,
    mods=(Modality.acoustic,),
):
    now = None
    from app.models import utcnow

    now = utcnow()
    return Track(
        track_id=track_id,
        status=status,
        det_class=cls,
        confidence=conf,
        first_seen=now,
        last_seen=now,
        lat=lat,
        lon=lon,
        node_ids=["N01"],
        modalities=list(mods),
        detection_count=2,
    )


def test_confirmed_drone_makes_high_priority_alert(settings, t0):
    ae = AlertingEngine(settings)
    alerts = ae.evaluate([_track(conf=0.9)], now=t0)
    assert len(alerts) == 1
    assert alerts[0].priority is AlertPriority.high
    assert alerts[0].det_class is DetectionClass.drone
    assert "DRONE" in alerts[0].summary


def test_tentative_track_makes_no_alert(settings, t0):
    ae = AlertingEngine(settings)
    assert ae.evaluate([_track(status=TrackStatus.tentative)], now=t0) == []


def test_low_confidence_is_low_priority(settings, t0):
    ae = AlertingEngine(settings)
    alerts = ae.evaluate([_track(conf=0.3)], now=t0)
    assert alerts[0].priority is AlertPriority.low


def test_alert_is_deduplicated_per_track(settings, t0):
    ae = AlertingEngine(settings)
    ae.evaluate([_track(conf=0.6)], now=t0)
    a1 = ae.snapshot()[0].alert_id
    ae.evaluate([_track(conf=0.95)], now=t0 + timedelta(seconds=5))
    snap = ae.snapshot()
    assert len(snap) == 1
    assert snap[0].alert_id == a1  # same alert, updated
    assert snap[0].confidence == 0.95


def test_proximity_to_asset_bumps_priority(settings, t0):
    asset = Position(lat=53.5410, lon=9.9820)  # right on the track
    ae = AlertingEngine(settings, protected_asset=asset)
    alerts = ae.evaluate([_track(cls=DetectionClass.person, conf=0.6)], now=t0)
    # person + 0.6 would be medium; proximity bumps to high
    assert alerts[0].priority is AlertPriority.high
