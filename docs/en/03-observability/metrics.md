---
title: "Metrics: Latency, Error Rate and Tokens"
description: Which metrics a gateway needs, how to name them, how to design buckets, and the TTFT and token throughput that matter most for LLM workloads.
---

# Metrics: Latency, Error Rate and Tokens

Logs answer "what happened to this one request"; metrics answer "is the whole system getting worse". The difference is not just data volume but **whether you can trend and alert** — you don't want to discover that the error rate went from 1% to 8% by reading logs by hand.

## The short version

- The classic four signals (traffic, latency, errors, saturation) still apply, but an LLM gateway must also watch **TTFT, token throughput, cache hit rate and fallback share**.
- **Put only low-cardinality fields in labels.** Be careful with `tenant_id`; `request_id` and `prompt` must never appear.
- Use histograms for latency, with buckets covering 60 seconds or more; otherwise long-context requests all land in `+Inf`.
- Split streaming "latency" into at least **TTFT** and **total duration**. Reporting only the total hides first-token experience problems.
- Alert on SLOs, not on a single instantaneous metric value.

## Metric inventory

### The generic four signals

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `gateway_requests_total` | counter | `method, path, status, model_alias, provider` | Total requests |
| `gateway_request_duration_seconds` | histogram | `model_alias, provider, stream` | End-to-end duration |
| `gateway_errors_total` | counter | `error_code, stage` | Normalized errors |
| `gateway_inflight_requests` | gauge | `model_alias` | Requests currently in flight |
| `gateway_upstream_inflight` | gauge | `provider` | Upstream concurrency |

### LLM-specific metrics

| Metric | Type | Notes |
| --- | --- | --- |
| `gateway_ttft_seconds` | histogram | Time to first token; essential for streaming |
| `gateway_tokens_total` | counter | Split by `direction=input/output/cached` |
| `gateway_tokens_per_second` | histogram | Generation speed, a proxy for upstream health |
| `gateway_cache_requests_total` | counter | Split by `result=hit/miss/bypass` |
| `gateway_cache_saved_tokens_total` | counter | Input tokens saved by caching |
| `gateway_route_attempts_total` | counter | Split by `target, attempt` |
| `gateway_fallback_total` | counter | Fallback / switch count |
| `gateway_circuit_state` | gauge | 0 closed / 1 half-open / 2 open |
| `gateway_cost_usd_total` | counter | Cumulative cost; use the `tenant` label carefully |
| `gateway_quota_rejected_total` | counter | Requests rejected by rate limits or budget |
| `gateway_upstream_retries_total` | counter | Retry count |

With this set you can answer most production questions: is traffic up, is upstream slow, or are we retrying like crazy?

## Naming conventions

The Prometheus ecosystem convention is `<namespace>_<subsystem>_<name>_<unit>`:

- Use **base units**: seconds, bytes, counts. Not milliseconds, or Grafana will be full of `/1000`.
- Counters end in `_total`.
- Don't give one metric two meanings, e.g. don't use `gateway_requests_total` for both received and sent.
- Label values use lowercase with underscores; never put user input in them.

## Histogram buckets

The default buckets (`0.005` to `10` seconds) are nowhere near enough for LLMs. Long-context requests routinely take 30–60 seconds, so define your own:

```python
from prometheus_client import Histogram

REQUEST_DURATION = Histogram(
    "gateway_request_duration_seconds",
    "End-to-end gateway request duration",
    ["model_alias", "provider", "stream"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300),
)

TTFT = Histogram(
    "gateway_ttft_seconds",
    "Time to first token",
    ["model_alias", "provider"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30),
)

OUTPUT_TOKENS = Histogram(
    "gateway_output_tokens",
    "Output tokens per request",
    ["model_alias"],
    buckets=(16, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384),
)
```

Two rules of thumb for bucket design:

1. **Cover past P99.** If 5% of requests exceed the largest bucket, your P99 is a lie.
2. **Add density around key thresholds.** If the SLO is "P95 TTFT < 2s", add buckets around 1.5/2/2.5.

## Instrumentation code

Record centrally in middleware instead of writing a variant in every handler:

```python
import time
from contextlib import contextmanager

from fastapi import Request
from prometheus_client import Counter, Gauge


REQUESTS = Counter(
    "gateway_requests_total", "Total requests",
    ["model_alias", "provider", "status", "stream"],
)
ERRORS = Counter(
    "gateway_errors_total", "Errors by code",
    ["error_code", "stage"],
)
INFLIGHT = Gauge(
    "gateway_inflight_requests", "In-flight requests", ["model_alias"],
)


@contextmanager
def observe_request(model_alias: str, provider: str, stream: bool):
    INFLIGHT.labels(model_alias).inc()
    start = time.perf_counter()
    status = "500"
    try:
        yield lambda s: None  # Callers can set the status through the returned value
    finally:
        duration = time.perf_counter() - start
        INFLIGHT.labels(model_alias).dec()
        REQUEST_DURATION.labels(model_alias, provider, str(stream).lower()).observe(duration)
```

Real projects usually pass the status code out through `request.state` or a return value rather than letting `finally` guess. The key is **ensuring the error path is also recorded**; otherwise failed requests are invisible in your metrics.

### TTFT for streaming requests

TTFT must be recorded when the first chunk is relayed, not when the request ends:

```python
async def relay_stream(upstream, request: Request, timer: PhaseTimer, labels: dict):
    first = True
    async for chunk in upstream.aiter_bytes():
        if first:
            timer.mark("first_token")
            TTFT.labels(**labels).observe(timer.elapsed_ms("first_token") / 1000)
            first = False
        await request.send(chunk)
    timer.mark("last_byte")
```

Note: the first chunk from `aiter_bytes()` does not necessarily contain visible text; it may be an SSE `role` event or a comment line. If your upstream sends heartbeats first, TTFT will be underestimated. The more accurate approach is to **parse the SSE stream and wait for the first event that carries `delta.content`**.

## The label cardinality trap

This is the most common Prometheus incident in production:

| Label | Cardinality | Usable |
| --- | --- | --- |
| `model_alias` | 10–100 | ✅ |
| `provider` | 5–20 | ✅ |
| `status` | ~20 | ✅ |
| `error_code` | 20–50 | ✅ |
| `tenant_id` | 10–100k | ⚠️ Large customers only, or a separate metric |
| `key_id` | thousands or more | ❌ Put it in logs |
| `request_id` | unbounded | ❌ |
| `path` (with IDs) | unbounded | ❌ Use the route template |
| `prompt` / `user_id` | unbounded | ❌ |

Every label combination creates a time series. `tenant_id` × `model` × `status` with a thousand tenants yields hundreds of thousands of series and blows Prometheus up.

When you need per-tenant views, take two paths:

1. **Send business metrics to logs or the warehouse**; keep only aggregates in Prometheus.
2. **Label the top N tenants explicitly** and bucket the rest as `tenant="other"`.

## Core PromQL

```promql
# QPS by model
sum by (model_alias) (rate(gateway_requests_total[5m]))

# 5xx error rate
sum(rate(gateway_requests_total{status=~"5.."}[5m]))
/
sum(rate(gateway_requests_total[5m]))

# P95 TTFT
histogram_quantile(
  0.95,
  sum by (le, model_alias) (rate(gateway_ttft_seconds_bucket[5m]))
)

# P99 end-to-end latency
histogram_quantile(
  0.99,
  sum by (le) (rate(gateway_request_duration_seconds_bucket[5m]))
)

# Cache hit rate
sum(rate(gateway_cache_requests_total{result="hit"}[5m]))
/
sum(rate(gateway_cache_requests_total{result=~"hit|miss"}[5m]))

# Fallback share
sum(rate(gateway_fallback_total[5m]))
/
sum(rate(gateway_requests_total[5m]))

# Token throughput (tokens/s)
sum(rate(gateway_tokens_total{direction="output"}[5m]))

# Cost per minute
sum(rate(gateway_cost_usd_total[5m])) * 60

# Upstream concurrency saturation (assuming a known limit of 200)
sum by (provider) (gateway_upstream_inflight) / 200
```

::: tip Aggregation order for `histogram_quantile`
You must `sum by (le, ...)` before computing the quantile; never average per-instance quantiles. With multiple replicas, `avg(histogram_quantile(...))` is simply wrong — quantiles are not additive.
:::

## SLIs and SLOs

Metrics are the raw material; SLOs are the promise. Define at least three SLIs:

| SLI | Definition | Example target |
| --- | --- | --- |
| Availability | Non-5xx requests / total requests | 99.9% / 30 days |
| Time to first token | TTFT P95 | < 2s |
| End-to-end latency | Non-streaming P95 | < 15s |

Watch the definition of "availability": **does an upstream 429 count as gateway unavailability?** From the user's point of view yes (they got no result); from the platform's point of view no (the gateway itself is fine). Split it into two SLIs:

- `gateway_availability`: the gateway's own errors (auth, routing, internal exceptions).
- `end_to_end_success`: the user ultimately received a valid response, including upstream factors.

That way, when upstream wobbles, you know who to call.

How to use the error budget: 99.9% over 30 days means about 43 minutes of unavailability. When more than 50% of the budget is consumed, freeze non-essential changes; past 100%, start an incident review. This maps closer to business experience than "page me when the error rate exceeds 1%".

## Latency for streaming requests

Streaming has three durations; mixing them is misleading:

| Phase | Meaning | What to watch |
| --- | --- | --- |
| TTFT | From request sent to the first visible token | The perceived response speed |
| Generation time | First token to last token | Output length, upstream speed |
| Total duration | Request sent to connection close | Billing, timeout configuration |

If you only monitor total duration, a request with "8s to first token, 1s generating" looks the same as one with "0.5s to first token, 8.5s generating", yet the user experience is completely different, and so is the right optimization.

You can also add a derived metric: **tokens/s = output_tokens / generation time**. A drop usually means the upstream is rate limiting or overloaded.

## Dashboard layout

A useful gateway dashboard usually has four rows:

1. **Top-line verdict**: QPS, error rate, P95 TTFT, P95 latency, current cost rate.
2. **Traffic and errors**: stacked request volume by model/provider, top 10 error codes.
3. **Latency**: quantile curves for TTFT and total duration, split by `stream`.
4. **Capacity and routing**: upstream concurrency, rate-limit rejections, fallback count, circuit breaker state, cache hit rate.

More panels is not better. On the first screen, the on-call engineer should be able to judge "is something wrong right now, and roughly where".

## Anti-patterns

| Anti-pattern | Consequence |
| --- | --- |
| Putting `request_id` in a label | Time series explosion, Prometheus OOM |
| Recording only successful requests | Error rate is always 0 |
| Using total duration instead of TTFT | First-token problems get averaged away |
| Keeping the default buckets | Long requests all land in `+Inf`, P99 distorts |
| Averaging quantiles | Wrong results across replicas |
| Different IDs in metrics and logs | You can't jump between them |
| Binding alerts to instantaneous values | Flapping causes alert fatigue |

## Checklist

- [ ] Four signals + TTFT + token throughput + cache hit rate + fallback share all have metrics
- [ ] Units are consistently seconds / bytes / counts
- [ ] Histogram buckets reach 300 seconds, with density near SLO thresholds
- [ ] Label cardinality is bounded; no `request_id`/`prompt`/unbounded `path`
- [ ] `tenant_id` is labeled only for the top N; the rest bucket into `other`
- [ ] Streaming requests record TTFT and generation speed separately
- [ ] Multi-replica aggregation uses `sum by (le)` before computing quantiles
- [ ] Two SLIs are defined: gateway availability and end-to-end success rate
- [ ] The first dashboard screen answers "is something wrong, and where"
- [ ] `trace_id` in metrics links to logs via exemplars

## Next

Metrics detect anomalies. Next you need to collect, alert on and localize them: [OpenTelemetry and Alerting](./otel-alerting.md).
