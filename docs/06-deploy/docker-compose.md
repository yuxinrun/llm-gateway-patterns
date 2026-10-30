---
title: Docker Compose 部署
description: 一份可直接运行的单机部署：网关、Redis、Postgres、Prometheus、Grafana 与 OTel Collector。
---

# Docker Compose 部署

单机 Compose 适合三类场景：本地开发、内部试用、以及「先跑起来再谈集群」。它的价值不是承载高并发，而是**把依赖关系和环境配置固化成可复现的一份文件**。

这一页给出一套完整可运行的编排，并说明哪些配置在生产必须改。

## 先说结论

- **网关进程保持无状态**，状态放 Redis/Postgres，否则扩容就是灾难。
- **健康检查分 liveness 与 readiness**，前者只判断进程是否活着，后者判断能否接流量。
- **不要用 `latest` 标签**，镜像和依赖都要固定版本。
- **容器以非 root 运行**，文件系统尽量只读。
- **SSE 必须经过支持流式的反向代理**，Nginx 默认配置会缓冲。
- **Compose 不解决高可用**，单机故障就是整体故障，生产要上编排系统。

## 组件

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

最小可用集是 `gateway + redis`。Postgres 用于配额、Key、账单；可观测三件套按需加。

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

几个决定：

- **`--workers 1`**：异步服务靠协程并发，多 worker 会增加内存且不利于连接复用。需要更多 CPU 时优先加副本。
- **`--proxy-headers`**：让应用能拿到真实客户端 IP，前提是信任的代理。
- **不用 `curl` 做健康检查**：slim 镜像里没有，装一个只为健康检查不值。
- **多阶段构建**：最终镜像不含编译工具，体积和攻击面都更小。

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

注意端口绑定到 `127.0.0.1`：除了 Nginx 的 80，其他服务不直接暴露到公网。这是个很容易被忽略的安全默认值。

## 环境变量

```bash
# .env.example
APP_ENV=production
LOG_LEVEL=info

# 上游
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

# 安全
KEY_PEPPER=change-me-32-bytes
ADMIN_TOKEN=change-me

# 可观测
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=llm-gateway

# 限流默认值
DEFAULT_RPM=300
DEFAULT_TPM=600000
DEFAULT_CONCURRENCY=30

GRAFANA_PASSWORD=change-me
```

生产环境不要把 `.env` 提交到仓库。用 Docker secret、Kubernetes Secret 或云厂商的密钥管理服务。Compose 的 `env_file` 只是开发便利，不是安全机制。

## Nginx 配置

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

        # SSE 必需
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

`/metrics` 不应该暴露在公网。Prometheus 在内网直接抓 `gateway:8000/metrics` 即可。

## 健康检查

两个端点，语义不同：

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

- `healthz` 只判断进程能否响应，**不检查依赖**。否则 Redis 抖动会导致容器被杀。
- `readyz` 检查依赖，失败时从负载均衡摘除，但不重启容器。

把两者混用是常见事故：依赖故障 → 健康检查失败 → 所有副本同时重启 → 更长时间不可用。

## 数据库初始化

用迁移工具（Alembic 或 golang-migrate），不要用 `create_all`：

```bash
docker compose run --rm gateway alembic upgrade head
```

迁移要有版本号、可重复执行、有回滚脚本。上线顺序：**先迁移，再发版**，且迁移必须向后兼容（旧版本代码能读新表结构）。

## 资源与限制

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

`limits` 在 Compose 下需要 Docker Swarm 或较新版本的 Compose 支持。即便不生效，也建议写上，迁移到 K8s 时可以直接复用这些数值。

内存限制要留出余量：流式响应、连接缓冲、日志队列都会占内存。出现过 OOM 就适当调大，并检查是否有泄漏。

## 日志

容器日志用 `json-file` + 轮转，避免把磁盘写满。生产更推荐直接输出到 stdout，由采集器（Fluent Bit、Vector）统一收集：

```yaml
logging:
  driver: json-file
  options:
    max-size: "50m"
    max-file: "5"
```

应用日志本身用 JSON 输出（见[结构化日志](../03-observability/logging-tracing.md)），不要依赖容器运行时加时间戳。

## 备份

| 数据 | 方式 | 频率 |
| --- | --- | --- |
| Postgres | `pg_dump` + 对象存储 | 每日全量 + WAL 归档 |
| Redis | AOF + RDB | 视可丢数据而定 |
| 配置 | Git | 每次变更 |

Redis 里如果是限流计数，丢了可以接受；如果是配额余额，丢了会导致超支或误限，需要定期持久化或落库校验。

## 生产必须改的项

| 项 | 开发默认 | 生产建议 |
| --- | --- | --- |
| 端口暴露 | 全部映射 | 只暴露 Nginx |
| 密码 | change-me | 密钥管理服务 |
| 镜像标签 | latest | 固定版本 + digest |
| 副本数 | 1 | ≥ 2，跨可用区 |
| 资源限制 | 无 | 明确 limits |
| 日志 | json-file | 集中采集 |
| TLS | 无 | 终止在 Nginx/LB |
| 备份 | 无 | 每日验证可恢复 |

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 用 `latest` | 无法复现，回滚困难 |
| 容器 root 运行 | 逃逸后影响宿主机 |
| 健康检查查依赖 | 依赖抖动导致全体重启 |
| Nginx 未关缓冲 | 流式退化为一次性 |
| 所有端口暴露公网 | 数据库/Redis 被扫 |
| `.env` 进仓库 | 密钥泄露 |
| 单副本 | 任何重启都是停机 |
| 用 `create_all` 建表 | 无法演进 schema |

## Checklist

- [ ] 镜像固定版本与 digest，多阶段构建
- [ ] 容器非 root，文件系统尽量只读
- [ ] `healthz` 与 `readyz` 分离
- [ ] 状态全部外置到 Redis/Postgres
- [ ] Nginx 关闭缓冲，超时覆盖最长流
- [ ] 只有反向代理暴露公网
- [ ] 密钥来自密钥管理，不入库不入镜像
- [ ] 数据库迁移可回滚且向后兼容
- [ ] 日志轮转与集中采集
- [ ] Postgres 每日备份并验证恢复
- [ ] 资源限制与副本数满足最低可用性

## 下一篇

单机跑通后，下一步是扩容：[无状态横向扩展](./scaling.md)。
