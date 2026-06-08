# ── builder ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder
WORKDIR /build
COPY pyproject.toml .
RUN pip install --upgrade pip && pip install hatchling && pip install --no-cache-dir .

# ── runtime ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime
WORKDIR /app

# Non-root user
RUN addgroup --gid 1000 app && adduser --uid 1000 --gid 1000 --no-create-home app

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY . .

USER app
EXPOSE 8000

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
