"""Mesh simulator.

Two layers, so the logic is testable without a network:
  * `generate_events(...)`  -> pure generator of (virtual_time, NodeMessage)
  * `run(...)`              -> posts them to the gateway, in real time or fast

CLI:
  uv run python -m sim.simulator --gateway http://127.0.0.1:8000 --scenario intruder_crossing
  uv run python -m sim.simulator --fast --seed 1 --print   # no server, just print
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import httpx

from app.config import ROOT
from app.geo import haversine_m
from app.models import DetectionClass, Modality, NodeInfo
from app.nodes import load_nodes
from sim.scenarios import SCENARIOS, Scenario

_TICK_S = 1.0
_MODALITY_BY_CLASS = {
    DetectionClass.drone: [Modality.acoustic, Modality.rf],
    DetectionClass.person: [Modality.pir, Modality.seismic],
    DetectionClass.vehicle: [Modality.seismic, Modality.magnetometer],
}
_FP_CLASSES = [DetectionClass.unknown, DetectionClass.person]
_FP_MODALITIES = [Modality.acoustic, Modality.pir, Modality.seismic]


def _msg(
    node_id: str,
    seq: int,
    modality: Modality,
    det_class: DetectionClass,
    confidence: float,
) -> dict:
    return {
        "node_id": node_id,
        "seq": seq,
        "modality": modality.value,
        "detection": {"class": det_class.value, "confidence": round(confidence, 3)},
    }


def generate_events(
    scenario: Scenario,
    nodes: dict[str, NodeInfo],
    seed: int = 0,
) -> Iterator[tuple[float, dict]]:
    """Yield (virtual_time_s, node_message_dict). Deterministic for a given seed."""
    rng = random.Random(seed)
    seq: dict[str, int] = {nid: 0 for nid in nodes}
    fp_prob_per_tick = scenario.false_positive_per_min / 60.0
    last_keepalive: dict[str, float] = {nid: -1e9 for nid in nodes}

    t = 0.0
    while t <= scenario.duration_s:
        for nid, node in nodes.items():
            # 1) keepalive
            if t - last_keepalive[nid] >= scenario.keepalive_interval_s:
                last_keepalive[nid] = t
                seq[nid] += 1
                yield t, _msg(nid, seq[nid], Modality.rf, DetectionClass.clear, 0.0)

            # 2) real intruder in range
            for intr in scenario.intruders:
                pos = intr.position_at(t)
                if pos is None:
                    continue
                dist = haversine_m(node.pos.lat, node.pos.lon, pos[0], pos[1])
                if (
                    dist <= scenario.detect_radius_m
                    and rng.random() < scenario.detect_prob_in_range
                ):
                    modality = rng.choice(_MODALITY_BY_CLASS[intr.true_class])
                    # closer => higher confidence, plus noise
                    closeness = 1.0 - dist / scenario.detect_radius_m
                    conf = min(
                        0.98, max(0.35, 0.45 + 0.45 * closeness + rng.gauss(0, 0.06))
                    )
                    seq[nid] += 1
                    yield t, _msg(nid, seq[nid], modality, intr.true_class, conf)

            # 3) scattered false positive
            if rng.random() < fp_prob_per_tick:
                seq[nid] += 1
                yield (
                    t,
                    _msg(
                        nid,
                        seq[nid],
                        rng.choice(_FP_MODALITIES),
                        rng.choice(_FP_CLASSES),
                        rng.uniform(0.3, 0.55),
                    ),
                )
        t += _TICK_S


def run(
    gateway: str | None,
    scenario: Scenario,
    nodes: dict[str, NodeInfo],
    seed: int = 0,
    fast: bool = False,
    do_print: bool = False,
) -> dict:
    """Drive the scenario. Returns a small summary. Needs httpx only if gateway is set."""
    if fast and gateway:
        print(
            "warning: --fast against a live gateway collapses the timeline; "
            "fusion/alert behaviour will NOT be realistic. Use real-time mode for the demo.",
            file=sys.stderr,
        )
    client = httpx.Client(base_url=gateway, timeout=5.0) if gateway else None

    sent = accepted = rejected = 0
    wall_start = time.monotonic()
    try:
        for vt, message in generate_events(scenario, nodes, seed=seed):
            if not fast and gateway:
                target = wall_start + vt
                delay = target - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
            if do_print:
                print(json.dumps(message))
            if client is not None:
                try:
                    resp = client.post("/ingest", json=message)
                    sent += 1
                    if resp.status_code == 200 and resp.json().get("accepted"):
                        accepted += 1
                    else:
                        rejected += 1
                except httpx.HTTPError as exc:
                    rejected += 1
                    print(f"post failed: {exc}", file=sys.stderr)
    finally:
        if client is not None:
            client.close()
    return {"sent": sent, "accepted": accepted, "rejected": rejected}


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="UGS mesh simulator")
    p.add_argument(
        "--gateway",
        default="http://127.0.0.1:8000",
        help="gateway base URL; empty string to only print",
    )
    p.add_argument("--scenario", default="intruder_crossing", choices=sorted(SCENARIOS))
    p.add_argument("--nodes-file", default=str(ROOT / "config" / "nodes.json"))
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--fast", action="store_true", help="no real-time pacing")
    p.add_argument(
        "--print", dest="do_print", action="store_true", help="echo every message"
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    nodes = load_nodes(Path(args.nodes_file))
    scenario = SCENARIOS[args.scenario]
    gateway = args.gateway or None
    summary = run(
        gateway=gateway,
        scenario=scenario,
        nodes=nodes,
        seed=args.seed,
        fast=args.fast,
        do_print=args.do_print,
    )
    print(f"done: {summary}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
