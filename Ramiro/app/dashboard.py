"""Operator dashboard (Streamlit). Reads the gateway API only — no direct DB access.

    uv run streamlit run app/dashboard.py --server.address=127.0.0.1

No map tiles on purpose (works offline at the venue): node and track positions
are shown on a plain lon/lat scatter. Swap in a real map once the site (Q23) and
venue internet (Q22) are known.
"""

from __future__ import annotations

import os
import time

import altair as alt
import pandas as pd
import requests
import streamlit as st

GATEWAY = os.environ.get("GATEWAY_URL", "http://127.0.0.1:8000")
_PRIORITY_COLOR = {"high": "#d62728", "medium": "#ff7f0e", "low": "#1f77b4"}
_STATUS_COLOR = {
    "confirmed": "#d62728",
    "tentative": "#ff7f0e",
    "stale": "#7f7f7f",
    "closed": "#cccccc",
}


def _get(path: str):
    r = requests.get(f"{GATEWAY}{path}", timeout=3)
    r.raise_for_status()
    return r.json()


st.set_page_config(page_title="UGS Mesh — Operator", layout="wide")
st.title("UGS Mesh — Operator view")

with st.sidebar:
    st.caption(f"Gateway: `{GATEWAY}`")
    auto = st.checkbox("Auto-refresh (2 s)", value=True)
    if st.button("Refresh now"):
        st.rerun()

try:
    nodes = _get("/nodes")
    tracks = _get("/tracks")
    alerts = _get("/alerts")
    stats = _get("/stats")
except requests.RequestException as exc:
    st.error(f"Cannot reach the gateway at {GATEWAY}\n\n{exc}")
    st.stop()

c1, c2, c3, c4 = st.columns(4)
c1.metric("Detections", stats["detections"])
c2.metric("Open tracks", stats["open_tracks"])
c3.metric("Alerts", stats["alerts"])
c4.metric("Nodes configured", len(nodes["configured"]))

# --- alerts ---------------------------------------------------------------- #
st.subheader("Alerts")
if alerts:
    st.dataframe(
        pd.DataFrame(alerts)[
            ["priority", "det_class", "confidence", "summary", "updated", "track_id"]
        ],
        use_container_width=True,
        hide_index=True,
    )
else:
    st.info("No alerts.")

# --- map (scatter) ------------------------------------------------------------ #
st.subheader("Perimeter")
cfg = pd.DataFrame(
    [
        {
            "node_id": n["node_id"],
            "name": n["name"],
            "lat": n["pos"]["lat"],
            "lon": n["pos"]["lon"],
        }
        for n in nodes["configured"]
    ]
)
layers = [
    alt.Chart(cfg)
    .mark_point(size=140, filled=True, color="#2ca02c")
    .encode(
        x=alt.X("lon:Q", scale=alt.Scale(zero=False)),
        y=alt.Y("lat:Q", scale=alt.Scale(zero=False)),
        tooltip=["node_id", "name"],
    ),
    alt.Chart(cfg)
    .mark_text(dy=-14, fontSize=11)
    .encode(x="lon:Q", y="lat:Q", text="node_id"),
]
if tracks:
    tdf = pd.DataFrame(tracks)
    layers.append(
        alt.Chart(tdf)
        .mark_point(size=220, filled=True, opacity=0.85)
        .encode(
            x="lon:Q",
            y="lat:Q",
            color=alt.Color(
                "status:N",
                scale=alt.Scale(
                    domain=list(_STATUS_COLOR), range=list(_STATUS_COLOR.values())
                ),
            ),
            tooltip=[
                "track_id",
                "status",
                "det_class",
                "confidence",
                "detection_count",
            ],
        )
    )
st.altair_chart(alt.layer(*layers).properties(height=420), use_container_width=True)

# --- tracks & nodes ------------------------------------------------------------ #
lc, rc = st.columns(2)
with lc:
    st.subheader("Tracks")
    st.dataframe(
        pd.DataFrame(tracks) if tracks else pd.DataFrame(),
        use_container_width=True,
        hide_index=True,
    )
with rc:
    st.subheader("Nodes seen")
    st.dataframe(
        pd.DataFrame(nodes["seen"]) if nodes["seen"] else pd.DataFrame(),
        use_container_width=True,
        hide_index=True,
    )

if auto:
    time.sleep(2)
    st.rerun()
