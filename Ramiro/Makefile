.PHONY: run sim dash test lint fmt clean

# Gateway API (bind to localhost only — see 05-opsec.md)
run:
	uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Mesh simulator -> gateway (real-time). Add --fast to dump quickly.
sim:
	uv run python -m sim.simulator --gateway http://127.0.0.1:8000 --scenario intruder_crossing

# Operator dashboard
dash:
	uv run streamlit run app/dashboard.py --server.address=127.0.0.1

test:
	uv run pytest -q

lint:
	uv run ruff check .

fmt:
	uv run ruff format .

clean:
	rm -rf data/*.duckdb .pytest_cache .ruff_cache
	find . -name __pycache__ -type d -not -path './.venv/*' -exec rm -r {} +
