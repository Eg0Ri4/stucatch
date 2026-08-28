"""Bridge: read newline-delimited JSON (from the root ESP32, or stdin for testing)
and POST each line to the gateway's /ingest.

    # with real hardware:
    uv run python -m app.serial_bridge --port /dev/ttyUSB0 --baud 115200

    # test the exact strings a sketch will emit, no hardware:
    printf '%s\n' '{"node_id":"N03","seq":1,"modality":"acoustic","detection":{"class":"drone","confidence":0.8}}' \
        | uv run python -m app.serial_bridge --stdin

Each line must be one JSON object matching app.models.NodeMessage. Malformed or
rejected lines are logged and skipped; the bridge keeps running.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Iterable, Iterator

import httpx

PostFn = Callable[[dict], tuple[int, str]]


def _iter_serial_lines(port: str, baud: int) -> Iterator[str]:
    try:
        import serial  # pyserial
    except ImportError:  # pragma: no cover - only hit without pyserial
        print("pyserial not installed: uv pip install pyserial", file=sys.stderr)
        raise SystemExit(2) from None

    with serial.Serial(port, baud, timeout=1) as ser:
        buf = b""
        while True:
            chunk = ser.read(256)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.strip().decode("utf-8", errors="replace")
                if text:
                    yield text


def _iter_stdin_lines() -> Iterator[str]:
    for line in sys.stdin:
        text = line.strip()
        if text:
            yield text


def forward_lines(lines: Iterable[str], post: PostFn) -> dict:
    """Parse each line and hand the payload to `post`. Returns a summary counter.

    `post(payload) -> (status_code, body_text)`. Non-JSON lines and non-2xx
    responses are counted and logged, never fatal.
    """
    summary = {"lines": 0, "sent": 0, "accepted": 0, "rejected": 0, "bad": 0}
    for raw in lines:
        text = raw.strip()
        if not text:
            continue
        summary["lines"] += 1
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            summary["bad"] += 1
            print(f"skip non-JSON: {text[:120]}", file=sys.stderr)
            continue
        try:
            status, body = post(payload)
        except Exception as exc:  # noqa: BLE001 - keep the bridge alive
            summary["bad"] += 1
            print(f"post failed: {exc}", file=sys.stderr)
            continue
        summary["sent"] += 1
        accepted = False
        if status == 200:
            try:
                accepted = bool(json.loads(body).get("accepted"))
            except json.JSONDecodeError:
                accepted = False
        if accepted:
            summary["accepted"] += 1
        else:
            summary["rejected"] += 1
            print(f"gateway {status}: {body[:200]}", file=sys.stderr)
    return summary


def _httpx_post(gateway: str) -> PostFn:
    client = httpx.Client(base_url=gateway, timeout=5.0)

    def post(payload: dict) -> tuple[int, str]:
        r = client.post("/ingest", json=payload)
        return r.status_code, r.text

    return post


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Serial/stdin -> gateway bridge")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--port", help="serial port, e.g. /dev/ttyUSB0")
    src.add_argument(
        "--stdin", action="store_true", help="read lines from stdin (testing)"
    )
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--gateway", default="http://127.0.0.1:8000")
    args = p.parse_args(argv if argv is not None else sys.argv[1:])

    lines = (
        _iter_stdin_lines() if args.stdin else _iter_serial_lines(args.port, args.baud)
    )
    try:
        summary = forward_lines(lines, _httpx_post(args.gateway))
    except KeyboardInterrupt:
        summary = {"note": "interrupted"}
    print(f"bridge stopped: {summary}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
