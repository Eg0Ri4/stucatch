"""Uvicorn entry point. Run: uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

The FastAPI app is created here (not in gateway.py) so that importing the factory
for tests never opens the real DuckDB file.
"""

from app.gateway import create_app

app = create_app()

__all__ = ["app"]
