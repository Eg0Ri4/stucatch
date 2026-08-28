# Pi-side services (gateway + dashboard). Same image, different command.
FROM python:3.12-slim

WORKDIR /app

# system deps kept minimal; wheels cover the rest
RUN pip install --no-cache-dir uv

COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

COPY app/ app/
COPY sim/ sim/
COPY config/ config/

ENV UGS_DB_PATH=/data/ugs.duckdb
VOLUME ["/data"]
EXPOSE 8000 8501

# default: the gateway. compose overrides for the dashboard.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
