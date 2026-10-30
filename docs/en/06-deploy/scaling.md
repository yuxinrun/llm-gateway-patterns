---
title: Stateless Horizontal Scaling
description: Move rate limiting, circuit breaking, sessions and configuration out of the process to design a gateway that scales safely.
---

# Stateless Horizontal Scaling

After a gateway grows to four replicas, a batch of "only happens with multiple replicas" problems tends to appear: rate-limit allowances become 4x, circuit states disagree, cache hit rate collapses, and a canary config is half applied. All of them have the same root cause: **state is still living in process memory**.

## The short version

- **Keep only rebuildable caches in the process.** Put anything that must be consistent in Redis/Postgres.
- **Rate limiting must be global**, or the real allowance is the per-replica allowance times the replica count.
- **Circuit breaking can stay local**, but add random jitter so replicas do not probe in lockstep.
- **Do not depend on session affinity.** Stickiness is an optimization, not a correctness requirement.
- **Graceful shutdown must wait for long streams to finish**, or every release cuts off answers that are still generating.
- **Scale on concurrency/queuing/TTFT**, not CPU alone.

## What counts as state

| State | Where it is now | Where it should be | Safe to lose? |
| --- | --- | --- | --- |
| Rate-limit counters | Process memory (bad) | Redis | Yes, briefly |
| Quota balances | Process memory (bad) | Redis + DB | No |
| Circuit state | Process memory (acceptable) | Local is fine, or shared via Redis | Yes |
| Route configuration | Loaded at startup (suboptimal) | Config service / DB + hot reload | No |
| Model prices | Code constants (suboptimal) | DB / configuration | No |
| Response cache | Local LRU (suboptimal) | Redis (shared across replicas) | Yes |
| Prefix cache | Upstream/instance | Not in the gateway | n/a |
| Session affinity | None | Redis (optimization) | Yes |
| Connection pools | In process (correct) | In process (where they belong) | n/a |

"Safe to lose" means losing it only affects performance or causes brief overspend, not correctness. **Rate-limit counters are safe to lose**, but losing them doubles traffic for a moment, so persisting them is still advisable.

## Statelessness migration checklist

1. Remove every module-level mutable dict or list (`_counters = {}`, `_state = []`).
2. Move rate limiting, quotas, circuit breaking and caching to Redis operations.
3. Change configuration from environment variables to "load at startup + refresh periodically + version number".
4. Write file uploads and temporary results to object storage, not local disk.
5. Write logs to stdout, not local files.
6. Put session data in Redis or a client token, not in the process.
7. Guard scheduled jobs with a distributed lock so each replica does not run them all.

Item 7 is the one most often missed: four replicas each run the "monthly billing aggregation", and the bill is computed four times.

```python
async def run_once(key: str, ttl: int = 3600) -> bool:
    return bool(await redis.set(key, "1", nx=True, ex=ttl))
```

## Rate limiting: globally consistent

A per-replica token bucket with four replicas means four times the allowance. Use Redis atomic operations (see [rate limiting and quotas](../02-production/rate-limit.md)).

```python
async def allow(redis, tenant_id: str, cost: int) -> tuple[bool, int]:
    key = f"rl:{tenant_id}:{minute_bucket()}"
    remaining = await redis.eval(TOKEN_BUCKET_LUA, 1, key, cost, LIMIT, WINDOW)
    return remaining >= 0, max(remaining, 0)
```

The cost is one extra Redis round trip per request (about 0.5-2ms). You can reduce it with local pre-aggregation:

- Each replica accumulates a small local allowance (say total allowance / replica count) and requests a new batch from Redis once it runs out.
- This cuts Redis QPS by an order of magnitude, at the cost of uneven distribution and some waste.

This is a classic accuracy-versus-performance tradeoff; choose per workload.

## Circuit breaking: local is fine, but add jitter

Keeping circuit state local is acceptable: each replica's view of upstream health may differ slightly, which actually prevents the oscillation of "everything opens at once, everything closes at once".

The key is jitter:

```python
import random


def recovery_delay(base: float = 30.0) -> float:
    return base * random.uniform(0.8, 1.2)
```

If strict consistency is required (for example, the upstream bills per key and frequent probes cost money), move the state to Redis, but update with last-write-wins plus a version number to avoid concurrent overwrites.

## Hot configuration reload

A configuration change should not require restarting every replica. A recommended structure:

```python
@dataclass(frozen=True)
class Config:
    version: str
    routes: dict
    quotas: dict
    prices: dict


class ConfigStore:
    def __init__(self, redis):
        self._redis = redis
        self._current = Config(version="0", routes={}, quotas={}, prices={})

    async def refresh(self) -> None:
        raw = await self._redis.get("config:current")
        if not raw:
            return
        data = json.loads(raw)
        if data["version"] != self._current.version:
            self._current = Config(**data)

    @property
    def current(self) -> Config:
        return self._current
```

Pair this with a background task that refreshes every 5-10 seconds. Notes:

- **Configuration needs a version number**, and logs should record the version in use so you can answer "why do two replicas behave differently".
- **On refresh failure, keep the old configuration**; do not clear it.
- **Audit critical configuration changes**: who changed what, and when.

### Ordering of config propagation

Make the new configuration visible on all replicas first, then shift traffic. If the configuration adds a model, make sure the upstream key and quota are ready first; otherwise you will see brief 404s/403s.

## Scaling metrics

CPU is the worst scaling signal. An async gateway has low CPU while waiting on the upstream, even when concurrency is saturated. Better metrics:

| Metric | Why |
| --- | --- |
| `gateway_inflight_requests` | Directly reflects concurrency pressure |
| Connection pool wait time | Shows that requests are queuing |
| P95 TTFT | The metric users actually feel |
| Event loop lag | Shows whether a replica is overloaded |
| Queued requests per second | Rises before latency does |

Example K8s HPA (custom metrics):

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: llm-gateway
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: llm-gateway
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Pods
      pods:
        metric:
          name: gateway_inflight_requests
        target:
          type: AverageValue
          averageValue: "40"
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
        - type: Percent
          value: 25
          periodSeconds: 120
```

Streaming requests have a characteristic shape: **scale out fast, scale in slowly**. A new replica can take traffic immediately, but scaling in cuts off in-flight streams. So the `scaleDown` stabilization window should be long, and must be paired with graceful shutdown.

## Graceful shutdown

```python
import asyncio
import signal

shutdown = asyncio.Event()


def handle_signal(*_):
    shutdown.set()


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)
```

Key points:

1. After SIGTERM, **stop accepting new connections** (readiness fails first).
2. Wait for in-flight requests to finish, up to `grace_period`.
3. On timeout, force close and log the number of unfinished requests.
4. Close upstream connection pools, flush logs, stop trace exporters.

```nginx
# On the Nginx side
proxy_next_upstream error timeout http_502;
```

K8s `terminationGracePeriodSeconds` must exceed the duration of the longest streaming request, or every release cuts off long answers. 300 seconds is a common setting, but if you allow 10-minute streams you need more.

::: warning Rolling updates briefly reduce capacity
A default rolling update starts new pods before stopping old ones, so capacity does not drop. But with `maxSurge: 0` it stops before starting, which may not hold up during peak. Avoid releasing during traffic peaks.
:::

## Bottlenecks in shared resources

As you add replicas, the bottleneck moves:

| Resource | Problem after scaling | Remedy |
| --- | --- | --- |
| Redis | Connection count, hot keys | Connection pooling, sharding, local pre-aggregation |
| Postgres | Connection count, write amplification | PgBouncer, batched writes, read replicas |
| Upstream quota | More replicas, same quota | Global quota, per-replica allocation |
| Egress IPs | Vendor rate-limits by IP | NAT gateway, multiple egresses |
| DNS | Resolution QPS rises | Local caching, longer TTLs |

Upstream quota is the most easily overlooked: the gateway goes from 2 to 20 replicas and QPS rises, but the vendor's RPM has not changed, so more requests hit 429 at the same time.

## Clocks and IDs

- All replicas must sync via NTP, or rate-limit windows and billing timestamps will disagree.
- Do not build distributed IDs from "timestamp + auto-increment". Use UUIDv7 or Snowflake.
- Generate `trace_id` from randomness, not from concatenated machine information.

## Deployment strategies

| Strategy | Pros | Cons |
| --- | --- | --- |
| Rolling | Simple, capacity does not drop | Old and new versions briefly coexist |
| Blue-Green | Clean switch, easy rollback | Requires double the resources |
| Canary | Lowest risk | Requires traffic splitting and comparison |

For services like a gateway that are "stateless with shared configuration", **Rolling + config canary** is recommended: release code with a rolling update and control behavioral changes (models, routes, prices) with configuration canaries, keeping the two decoupled.

## Anti-patterns

| Anti-pattern | Consequence |
| --- | --- |
| Rate-limit counters in the process | Real allowance = replica count x configured value |
| Scheduled jobs without a distributed lock | Bills and reports computed multiple times |
| Configuration loaded only at startup | A config change requires restarting every replica |
| Scaling on CPU alone | CPU is low while waiting on the upstream, so you never scale out |
| Scale-in window too short | In-flight streams get cut |
| Treating session affinity as correctness | Sessions are lost when a replica restarts |
| More replicas but the same upstream quota | More 429s, not fewer |
| Clocks out of sync | Rate-limit windows and billing drift |

## Checklist

- [ ] No mutable shared state inside the process
- [ ] Rate limits and quotas live in Redis and are consistent across replicas
- [ ] Circuit breaking is local with jitter, or shared via Redis
- [ ] Configuration supports hot reload, version numbers and auditing
- [ ] Scheduled jobs are guarded by a distributed lock
- [ ] Scaling is based on concurrency/queuing/TTFT, not CPU alone
- [ ] SIGTERM triggers graceful shutdown that waits for long streams
- [ ] `terminationGracePeriodSeconds` covers the longest stream
- [ ] The scaling limits of Redis/Postgres/upstream quota are evaluated
- [ ] All nodes are NTP-synced
- [ ] Releases avoid traffic peaks and keep a rollback path

## Next

Scaling also widens the security boundary: [security hardening and input protection](./security.md).
