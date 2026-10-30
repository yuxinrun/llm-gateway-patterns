---
title: Docker Compose Deployment
description: A runnable single-host deployment with the gateway, Redis, Postgres, Prometheus, Grafana and the OTel Collector.
---

# Docker Compose Deployment

A single-host Compose setup fits three cases: local development, internal pilots, and "get it running before we talk about clusters". Its value is not raw throughput. It is **freezing dependencies and environment configuration into one reproducible file**.

This page gives a complete, runnable stack, and explains which settings you must change for production.

## The short version

- **Keep the gateway process stateless.** Put state in Redis/Postgres, or scaling becomes a disaster.
- **Split health checks into liveness and readiness**: the first only asks whether the process is alive, the second whether it can accept traffic.
- **Do not use the `latest` tag.** Pin versions for images and dependencies.
- **Run containers as non-root**, with a read-only filesystem where possible.
- **SSE must go through a streaming-aware reverse proxy.** Nginx buffers by default.
- **Compose does not give you high availability.** A single host failure is a total failure. Production needs an orchestrator.

## Components

```mermaid
flowchart TB
  C["Client"] --> N["Nginx"]
  N --> G["gateway x1"]
  G --> R["Redis"]
  G --> P["Postgres"]
  G --> O["OTel Collector"]
  O --> T["Tempo / Jaeger"]
  O --> L["Loki"]
  PR["Prometheus"] --> G
  PR --> O
  GF["Grafana"] --> PR
  GF --> L
```

The minimum viable set is `gateway + redis`. Postgres holds quotas, keys and billing; add the observability trio as needed.

## Dockerfile

```dockerfile
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build
COPY requirements.txt .
RUN pip install --prefix=/install -r requirements.txt

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/install/bin:$PATH" \
    PYTHONPATH="/install/lib/python3.12/site-packages"

RUN groupadd -r app && useradd -r -g app -u 10001 app

WORKDIR /app
COPY --from=builder /install /install
COPY --chown=app:app app ./app
COPY --chown=app:app config ./config

USER 10001
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
```

A few decisions:

- **`--workers 1`**: an async service gets concurrency from coroutines. Multiple workers increase memory and hurt connection reuse. When you need more CPU, add replicas first.
- **`--proxy-headers`**: lets the app see the real client IP, provided the proxy is trusted.
- **No `curl` for the health check**: slim images do not include it, and installing it just for a health check is not worth it.
- **Multi-stage build**: the final image contains no build toolchain, so it is smaller and has a smaller attack surface.

## compose.yaml

```yaml
name: llm-gateway

services:
  gateway:
    build: .
    image: llm-gateway:1.4.2
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:8000:8000"
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]
      interval: 15s
      timeout: 3s
      retries: 3
      start_period: 15s
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 1g
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

  redis:
    image: redis:7.4.1-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "512mb", "--maxmemory-policy", "allkeys-lru"]
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  postgres:
    image: postgres:16.4-alpine
    restart: unless-stopped
    env_file: .env
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 3s
      retries: 5

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.111.0
    restart: unless-stopped
    command: ["--config=/etc/otel/config.yaml"]
    volumes:
      - ./deploy/otel-config.yaml:/etc/otel/config.yaml:ro
    ports:
      - "127.0.0.1:4318:4318"

  prometheus:
    image: prom/prometheus:v2.55.1
    restart: unless-stopped
    volumes:
      - ./deploy/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prom-data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"

  grafana:
    image: grafana/grafana:11.3.0
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD}
      GF_USERS_ALLOW_SIGN_UP: "false"
    volumes:
      - grafana-data:/var/lib/grafana
    ports:
      - "127.0.0.1:3000:3000"

  nginx:
    image: nginx:1.27.3-alpine
    restart: unless-stopped
    volumes:
      - ./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    ports:
      - "80:80"
    depends_on:
      - gateway

volumes:
  redis-data:
  pg-data:
  prom-data:
  grafana-data:
```

Note that ports bind to `127.0.0.1`: apart from Nginx on port 80, no service is exposed directly to the internet. This is an easy security default to overlook.

## Environment variables

```bash
# .env.example
APP_ENV=production
LOG_LEVEL=info

# Upstreams
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...

# Redis
REDIS_URL=redis://redis:6379/0

# Postgres
POSTGRES_DB=gateway
POSTGRES_USER=gateway
POSTGRES_PASSWORD=change-me-in-prod
DATABASE_URL=postgresql://gateway:change-me-in-prod@postgres:5432/gateway

# Security
KEY_PEPPER=change-me-32-bytes
ADMIN_TOKEN=change-me

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=llm-gateway

# Rate limit defaults
DEFAULT_RPM=300
DEFAULT_TPM=600000
DEFAULT_CONCURRENCY=30

GRAFANA_PASSWORD=change-me
```

Never commit `.env` to the repository in production. Use Docker secrets, Kubernetes Secrets or your cloud provider's secret manager. Compose `env_file` is a development convenience, not a security mechanism.

## Nginx configuration

```nginx
upstream gateway_upstream {
    server gateway:8000;
    keepalive 64;
}

server {
    listen 80;
    server_name _;

    client_max_body_size 20m;

    location /healthz {
        proxy_pass http://gateway_upstream;
        access_log off;
    }

    location /v1/ {
        proxy_pass http://gateway_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Required for SSE
        proxy_buffering off;
        proxy_cache off;
        proxy_request_buffering off;
        chunked_transfer_encoding on;
        add_header X-Accel-Buffering no;

        proxy_connect_timeout 10s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
    }

    location /metrics {
        deny all;
        return 404;
    }
}
```

`/metrics` should not be exposed to the internet. Prometheus can scrape `gateway:8000/metrics` directly on the internal network.

## Health checks

Two endpoints with different meanings:

```python
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/readyz")
async def readyz():
    checks = {}
    try:
        await redis.ping()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {type(exc).__name__}"
    try:
        await db.fetchval("SELECT 1")
        checks["postgres"] = "ok"
    except Exception as exc:
        checks["postgres"] = f"error: {type(exc).__name__}"

    ok = all(v == "ok" for v in checks.values())
    return JSONResponse({"status": "ok" if ok else "degraded", "checks": checks}, status_code=200 if ok else 503)
```

- `healthz` only asks whether the process can respond and **does not check dependencies**. Otherwise a Redis hiccup kills the container.
- `readyz` checks dependencies; on failure the instance is removed from the load balancer but the container is not restarted.

Conflating the two causes a classic incident: dependency failure, then health check failure, then every replica restarts at once, then a longer outage.

## Database initialization

Use a migration tool (Alembic or golang-migrate), not `create_all`:

```bash
docker compose run --rm gateway alembic upgrade head
```

Migrations need version numbers, must be repeatable, and need rollback scripts. Deploy order: **migrate first, then release**, and migrations must be backward compatible (old code can read the new schema).

## Resources and limits

```yaml
deploy:
  resources:
    limits:
      cpus: "2.0"
      memory: 1g
    reservations:
      cpus: "0.5"
      memory: 256m
```

`limits` requires Docker Swarm or a recent Compose version under Compose. Even if they are not enforced, write them down: you can reuse the values directly when you move to K8s.

Leave memory headroom: streaming responses, connection buffers and log queues all consume memory. If you see an OOM, raise the limit moderately and check for leaks.

## Logging

Use `json-file` with rotation for container logs so disks do not fill up. In production, prefer writing straight to stdout and collecting centrally with an agent (Fluent Bit, Vector):

```yaml
logging:
  driver: json-file
  options:
    max-size: "50m"
    max-file: "5"
```

Emit application logs as JSON (see [structured logging](../03-observability/logging-tracing.md)) instead of relying on the container runtime to add timestamps.

## Backup

| Data | Method | Frequency |
| --- | --- | --- |
| Postgres | `pg_dump` + object storage | Daily full backup + WAL archiving |
| Redis | AOF + RDB | Depends on tolerance for data loss |
| Configuration | Git | Every change |

If Redis holds rate-limit counters, losing them is acceptable. If it holds quota balances, losing them causes overspend or wrongful throttling, so persist periodically or reconcile against the database.

## What you must change for production

| Item | Development default | Production recommendation |
| --- | --- | --- |
| Port exposure | Everything mapped | Only Nginx |
| Passwords | change-me | Secret manager |
| Image tags | latest | Pinned version + digest |
| Replica count | 1 | >= 2, across availability zones |
| Resource limits | None | Explicit limits |
| Logging | json-file | Centralized collection |
| TLS | None | Terminate at Nginx/LB |
| Backups | None | Daily restore verification |

## Anti-patterns

| Anti-pattern | Consequence |
| --- | --- |
| Using `latest` | Not reproducible, hard to roll back |
| Running containers as root | Escapes affect the host |
| Health checks that probe dependencies | A dependency blip restarts everything |
| Nginx buffering left on | Streaming degrades to a single response |
| All ports exposed publicly | Databases and Redis get scanned |
| `.env` committed to the repo | Secret leakage |
| Single replica | Any restart is downtime |
| Creating tables with `create_all` | The schema cannot evolve |

## Checklist

- [ ] Images pinned by version and digest, multi-stage build
- [ ] Containers run as non-root, filesystem read-only where possible
- [ ] `healthz` and `readyz` are separate
- [ ] All state lives in Redis/Postgres
- [ ] Nginx buffering disabled, timeouts cover the longest stream
- [ ] Only the reverse proxy is exposed publicly
- [ ] Secrets come from a secret manager, never from the repo or the image
- [ ] Database migrations are reversible and backward compatible
- [ ] Log rotation plus centralized collection
- [ ] Daily Postgres backups with verified restores
- [ ] Resource limits and replica count meet minimum availability

## Next

Once it runs on a single host, the next step is scaling: [stateless horizontal scaling](./scaling.md).
