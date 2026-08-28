from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.config import Settings
from app.models import DetectionClass, Modality, NodeInfo, Position
from app.store import Store


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        db_path=tmp_path / "test.duckdb",
        nodes_file=tmp_path / "nodes.json",
    )


@pytest.fixture
def store() -> Store:
    s = Store(":memory:")
    yield s
    s.close()


@pytest.fixture
def nodes() -> dict[str, NodeInfo]:
    return {
        "N01": NodeInfo(
            node_id="N01", name="North", pos=Position(lat=53.5432, lon=9.9740)
        ),
        "N02": NodeInfo(
            node_id="N02", name="NE", pos=Position(lat=53.5433, lon=9.9800)
        ),
        "N03": NodeInfo(
            node_id="N03", name="East", pos=Position(lat=53.5410, lon=9.9820)
        ),
    }


@pytest.fixture
def t0() -> datetime:
    return datetime(2026, 8, 30, 10, 0, 0, tzinfo=UTC)


def make_message(
    node_id="N01",
    seq=1,
    modality=Modality.acoustic,
    det_class=DetectionClass.drone,
    confidence=0.8,
):
    """Build a raw node message dict (as it would arrive as JSON)."""
    return {
        "node_id": node_id,
        "seq": seq,
        "modality": modality.value if isinstance(modality, Modality) else modality,
        "detection": {
            "class": det_class.value
            if isinstance(det_class, DetectionClass)
            else det_class,
            "confidence": confidence,
        },
    }
