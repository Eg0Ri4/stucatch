"""Demo scenarios: a node layout plus a scripted intruder path.

Kept separate from the simulator loop so the geometry is easy to read and tweak.
Positions are interpolated linearly between waypoints.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models import DetectionClass


@dataclass(frozen=True)
class Waypoint:
    t: float  # seconds from scenario start
    lat: float
    lon: float


@dataclass(frozen=True)
class Intruder:
    name: str
    true_class: DetectionClass
    path: list[Waypoint]

    def position_at(self, t: float) -> tuple[float, float] | None:
        """Linear interpolation along the path; None before start / after end."""
        if not self.path or t < self.path[0].t or t > self.path[-1].t:
            return None
        for a, b in zip(self.path, self.path[1:], strict=False):
            if a.t <= t <= b.t:
                span = b.t - a.t
                f = 0.0 if span == 0 else (t - a.t) / span
                return (a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon))
        return (self.path[-1].lat, self.path[-1].lon)


@dataclass(frozen=True)
class Scenario:
    name: str
    duration_s: float
    intruders: list[Intruder] = field(default_factory=list)
    keepalive_interval_s: float = 5.0
    # detection behaviour
    detect_radius_m: float = 180.0  # a node "hears" an intruder within this range
    detect_prob_in_range: float = (
        0.7  # chance a node reports on a given tick when in range
    )
    false_positive_per_min: float = 0.8  # scattered wind/bird style noise, per node


# --- the default demo: one drone crossing the NE sector --------------------- #
INTRUDER_CROSSING = Scenario(
    name="intruder_crossing",
    duration_s=180.0,
    intruders=[
        Intruder(
            name="drone-1",
            true_class=DetectionClass.drone,
            path=[
                Waypoint(t=40.0, lat=53.5445, lon=9.9770),  # comes in from the north
                Waypoint(t=90.0, lat=53.5433, lon=9.9800),  # passes NE fence (N02)
                Waypoint(
                    t=140.0, lat=53.5412, lon=9.9818
                ),  # toward the east jetty (N03)
            ],
        )
    ],
)

QUIET = Scenario(name="quiet", duration_s=120.0, intruders=[])

SCENARIOS: dict[str, Scenario] = {
    INTRUDER_CROSSING.name: INTRUDER_CROSSING,
    QUIET.name: QUIET,
}
