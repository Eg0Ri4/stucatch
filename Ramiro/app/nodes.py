"""Load the node registry (config/nodes.json)."""

from __future__ import annotations

import json
from pathlib import Path

from app.models import NodeInfo, Position


def load_nodes(path: str | Path) -> dict[str, NodeInfo]:
    """Return {node_id: NodeInfo}. Raises if the file is missing or malformed."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    nodes: dict[str, NodeInfo] = {}
    for item in raw["nodes"]:
        info = NodeInfo(
            node_id=item["node_id"],
            name=item["name"],
            pos=Position(lat=item["lat"], lon=item["lon"]),
        )
        if info.node_id in nodes:
            raise ValueError(f"duplicate node_id in registry: {info.node_id}")
        nodes[info.node_id] = info
    if not nodes:
        raise ValueError("node registry has no nodes")
    return nodes


def load_protected_asset(path: str | Path) -> Position | None:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    asset = raw.get("protected_asset")
    if not asset:
        return None
    return Position(lat=asset["lat"], lon=asset["lon"])
