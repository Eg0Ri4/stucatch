from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.models import (
    Detection,
    DetectionClass,
    Modality,
    NodeInfo,
    NodeMessage,
    Position,
)
from tests.conftest import make_message


def test_valid_message_parses():
    msg = NodeMessage.model_validate(make_message(confidence=0.42))
    assert msg.node_id == "N01"
    assert msg.modality is Modality.acoustic
    assert msg.detection.det_class is DetectionClass.drone
    assert msg.detection.confidence == 0.42


def test_class_alias_accepted_both_ways():
    # incoming JSON uses "class"
    assert (
        NodeMessage.model_validate(make_message()).detection.det_class
        is DetectionClass.drone
    )


@pytest.mark.parametrize("confidence", [-0.1, 1.1, 2.0])
def test_confidence_out_of_range_rejected(confidence):
    with pytest.raises(ValidationError):
        NodeMessage.model_validate(make_message(confidence=confidence))


def test_unknown_modality_rejected():
    with pytest.raises(ValidationError):
        NodeMessage.model_validate(make_message(modality="lidar"))


def test_extra_fields_rejected():
    bad = make_message()
    bad["surprise"] = 1
    with pytest.raises(ValidationError):
        NodeMessage.model_validate(bad)


def test_negative_seq_rejected():
    with pytest.raises(ValidationError):
        NodeMessage.model_validate(make_message(seq=-1))


def test_position_bounds():
    with pytest.raises(ValidationError):
        Position(lat=95.0, lon=0.0)


def test_detection_from_message_enriches():
    msg = NodeMessage.model_validate(make_message(node_id="N03", confidence=0.7))
    node = NodeInfo(node_id="N03", name="East", pos=Position(lat=53.541, lon=9.982))
    ts = datetime(2026, 8, 30, 10, 0, 0, tzinfo=UTC)
    det = Detection.from_message(msg, node, ts=ts)
    assert det.lat == 53.541 and det.lon == 9.982
    assert det.ts == ts
    assert det.det_class is DetectionClass.drone
    assert det.confidence == 0.7
