---
title: OpenTelemetry and Alerting
description: Unify traces, metrics and logs with OTel, instrument against the GenAI semantic conventions, and design SLO-based alerts and runbooks.
---

# OpenTelemetry and Alerting

A classic failure scene: logs in Loki, metrics in Prometheus, traces in Jaeger, three systems and three IDs. When something breaks you bounce between three browser tabs and end up guessing. The value of OpenTelemetry is not "one more SDK" but **making all three signal types share the same resources and context**.

## The short version

- Use **OTLP** as the single egress, so the backend can change (Tempo, Jaeger, Datadog, Alibaba Cloud ARMS) without touching instrumentation code.
- Name upstream attributes and spans per the **GenAI semantic conventions**, so any platform that supports them can read your data later.
- **A streaming span ends at the last byte.** Record TTFT as an event or attribute; do not call `end()` before the stream finishes.
- Alert on **symptoms**, not causes: users experience "high error rate" and "slow first token", not "a counter went up".
- Every alert needs a runbook, otherwise it is just a noise source.

## How the three signals divide the work

| Signal | Question it answers | Retention | Cost |
| --- | --- | --- | --- |
| Traces | Where did this request get slow | 3–14 days | High |
| Metrics | Overall trend, whether we are out of bounds | Months to years | Low |
| Logs | Specific context, stack traces | 7–30 days | Medium |

In practice the combination is: **metrics detect → traces localize → logs explain**. That means the correlation ID must be the same everywhere: the same `trace_id` has to take you from a metric exemplar in Grafana to Tempo, and from a span to the logs in Loki.

## GenAI semantic conventions

OpenTelemetry defines a set of attributes for generative AI. Support varies by language SDK and Collector version; this is the most commonly used subset (the official semconv docs are authoritative):

| Attribute | Example | Notes |
| --- | --- | --- |
| `gen_ai.system` | `openai` | Vendor identifier |
| `gen_ai.operation.name` | `chat` | Operation type |
| `gen_ai.request.model` | `gpt-4o-mini` | Requested model |
| `gen_ai.response.model` | `gpt-4o-mini-2024-07-18` | Model actually served |
| `gen_ai.request.max_tokens` | `1024` | Maximum output |
| `gen_ai.request.temperature` | `0.7` | Sampling temperature |
| `gen_ai.usage.input_tokens` | `1832` | Input tokens |
| `gen_ai.usage.output_tokens` | `517` | Output tokens |
| `gen_ai.response.finish_reasons` | `["stop"]` | Finish reasons |

::: warning The conventions are still evolving
The GenAI semconv is still experimental and attribute names may change. Define the names as constants in one place so an upgrade touches a single file; keep a custom prefix (such as `lgw.*`) for gateway-specific fields so they never collide with standard attributes.
:::

Gateway-specific attributes deserve their own namespace:

| Attribute | Notes |
| --- | --- |
| `lgw.tenant_id` | Tenant |
| `lgw.route.group` | Routing group |
| `lgw.route.attempt` | Attempt number |
| `lgw.cache.result` | hit / miss / bypass |
| `lgw.ttft_ms` | Time to first token |
| `lgw.cost_usd` | Cost of this request |
| `lgw.fallback.from` | Target fallen back from |

## Python setup

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

resource = Resource.create({
    "service.name": "llm-gateway",
    "service.version": "1.4.2",
    "deployment.environment": "prod",
    "cloud.region": "cn-hangzhou",
})

provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint="http://otel-collector:4318/v1/traces"),
        max_queue_size=4096,
        max_export_batch_size=512,
        schedule_delay_millis=2000,
    )
)
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("llm_gateway")
```

`BatchSpanProcessor` is mandatory. Synchronous export blocks on network I/O inside every request and will push latency up at peak. A full queue drops spans, so monitor the `dropped_spans` metrics.

### Instrumenting the upstream span by hand

```python
from opentelemetry.trace import Status, StatusCode


async def call_upstream(target, payload, timer):
    with tracer.start_as_current_span("upstream.chat") as span:
        span.set_attributes({
            "gen_ai.system": target.provider,
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": target.model,
            "lgw.route.group": target.group,
            "lgw.route.attempt": target.attempt,
            "server.address": target.host,
        })

        try:
            response = await client.post(target.url, json=payload)
        except httpx.TimeoutException as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, "upstream_timeout"))
            raise

        span.set_attribute("http.response.status_code", response.status_code)
        if response.status_code >= 500:
            span.set_status(Status(StatusCode.ERROR, "upstream_5xx"))
        return response
```

### When a streaming span should end

The easiest place to get streaming wrong: the `client.stream()` context manager exits as soon as the response headers arrive. If the span calls `end()` when the `with` block exits, the entire generation time is missing from the span.

```python
async def stream_upstream(target, payload, timer):
    span = tracer.start_span("upstream.chat.stream")
    span.set_attribute("gen_ai.request.model", target.model)
    try:
        async with client.stream("POST", target.url, json=payload) as response:
            span.set_attribute("http.response.status_code", response.status_code)
            async for chunk in response.aiter_bytes():
                if timer.ttft_ms is None:
                    timer.mark("first_token")
                    span.add_event("first_token", {"lgw.ttft_ms": timer.elapsed_ms("first_token")})
                yield chunk
    except Exception as exc:
        span.record_exception(exc)
        span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
        raise
    finally:
        span.set_attribute("lgw.duration_ms", timer.elapsed_ms())
        span.end()
```

Three rules:

1. **Manage the span manually** instead of using `with`, because it has to span the generator's lifetime.
2. **Record TTFT as an event**; it carries a timestamp and tells you more than a bare attribute.
3. **Call `end()` even when the client disconnects**, in `finally`, or the span leaks.

### Context propagation

Async tasks, thread pools and message queues all lose context. Anything that continues after the request (billing, audit, async callbacks) needs explicit propagation:

```python
import asyncio
from opentelemetry import context as otel_context


def spawn_tracked(coro):
    ctx = otel_context.get_current()
    return asyncio.create_task(coro, context=ctx)
```

`create_task` accepts a `context` argument from Python 3.11. On older versions, wrap with `contextvars.copy_context()`.

## OTel or Prometheus

The two approaches are often mixed; the right choice depends on your backend:

| Approach | Pros | Cost |
| --- | --- | --- |
| Prometheus client exposes `/metrics` directly | Mature ecosystem, powerful PromQL | Covers metrics only |
| OTel SDK emits all three signals | Shared context, replaceable backend | Weaker metrics ecosystem, higher overhead |
| Hybrid: metrics via Prometheus, traces via OTel | Best of both | You must keep `trace_id` correlatable |

The hybrid is the recommendation, but **define business semantics in exactly one place**. For example, TTFT buckets and labels live in one module that both Prometheus and OTel read from, so there is no second definition to drift.

## Collector pipeline

Don't point the application at multiple backends. Put a Collector in between to handle batching, sampling, redaction and routing:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 1024
    spike_limit_mib: 256
  batch:
    timeout: 5s
    send_batch_size: 1024
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 10000 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
  attributes:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: lgw.prompt
        action: delete

exporters:
  otlphttp/tempo:
    endpoint: http://tempo:4318
  prometheus:
    endpoint: 0.0.0.0:8889
  loki:
    endpoint: http://loki:3100/loki/api/v1/push

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlphttp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes, batch]
      exporters: [loki]
```

Practical notes:

- `memory_limiter` must come first; an OOM-killed Collector drops every signal.
- `tail_sampling` waits for `decision_wait`; too short and it decides before the error span arrives.
- Redaction in the Collector rather than the app centralizes the rules, at the cost of sensitive data leaving the process. High-sensitivity environments should strip it in the app first.
- With multiple Collector replicas, tail sampling needs `trace_id`-based load balancing (the `loadbalancing` exporter); otherwise spans of one trace scatter across instances and the sampling decision is incomplete.

## Alert design

### Alert on symptoms

| Alert | Expression (example) | For | Severity |
| --- | --- | --- | --- |
| High error rate | `job:gateway_error_ratio:5m > 0.05` | 5m | P1 |
| Slow first token | `job:gateway_ttft_p95:5m > 3` | 10m | P2 |
| Slow end to end | `job:gateway_latency_p95:5m > 20` | 10m | P2 |
| Full fallback | `sum(rate(gateway_fallback_total[5m])) / sum(rate(gateway_requests_total[5m])) > 0.3` | 5m | P1 |
| Budget burning too fast | `predict_linear(gateway_cost_usd_total[6h], 86400) > budget * 2` | 15m | P2 |
| Cache collapse | `gateway_cache_requests_total{result="hit"} / ignoring(result) sum(...) < 0.1` | 15m | P3 |
| Upstream circuit open | `gateway_circuit_state == 2` | 2m | P2 |
| Collection stalled | `up == 0` | 2m | P1 |

The "For" column matters a lot. Instantaneous thresholds make alerts flap and on-call engineers quickly learn to ignore them.

### Multi-window burn rate

Single-threshold alerts are either too blunt or too chatty. SLO burn rate looks at long and short windows together, balancing sensitivity and stability:

```yaml
groups:
  - name: gateway-slo
    rules:
      - alert: GatewayErrorBudgetFastBurn
        expr: |
          (
            job:gateway_error_ratio:5m > (14.4 * 0.001)
            and
            job:gateway_error_ratio:1h > (14.4 * 0.001)
          )
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "Gateway error budget burning fast"
          runbook: "https://github.com/yuxinrun/llm-gateway-patterns/blob/main/docs/03-observability/otel-alerting.md"

      - alert: GatewayErrorBudgetSlowBurn
        expr: |
          (
            job:gateway_error_ratio:30m > (6 * 0.001)
            and
            job:gateway_error_ratio:6h > (6 * 0.001)
          )
        for: 15m
        labels:
          severity: ticket
```

This assumes a 99.9% SLO (error budget 0.001). `14.4` and `6` are conventional burn-rate multipliers: short windows catch spikes, long windows prevent false positives.

### Alert severity

| Severity | Meaning | Response | Notification |
| --- | --- | --- | --- |
| P1 | Users broadly unable to use the service | Immediately | Phone + group chat |
| P2 | Clear degradation or overspend risk | Within 30 minutes | Chat + ticket |
| P3 | Anomalous trend, not yet user-visible | Same day | Ticket |
| P4 | Informational | Weekly report | Dashboard |

Severity exists to **cap the number of P1s**. If you get three P1s every night, severity has lost its meaning.

### Inhibition and silences

- **Inhibition**: during a broad upstream outage, suppress every downstream derived alert and keep only the root cause.
- **Silences**: silence planned changes (releases, scaling) in advance, but always with an expiry, so nobody forgets to turn it off.
- **Grouping**: aggregate by `service` + `alertname` so one incident doesn't produce 200 notifications.

```yaml
inhibit_rules:
  - source_match:
      alertname: GatewayUpstreamDown
    target_match_re:
      alertname: Gateway(ErrorRateHigh|TTFTSlow)
    equal: ["provider"]
```

## What goes in a runbook

Every P1/P2 alert should have a page you can follow directly:

1. **Symptoms**: what users see, what the metrics look like.
2. **Blast radius**: which tenants, which models, whether it is total.
3. **Quick triage**: three commands or three dashboard links to separate "our problem" from "the upstream's problem".
4. **Mitigation**: shift traffic, fall back, rate limit, roll back, ordered from cheapest to most expensive.
5. **Escalation**: who to call, after how long.
6. **Afterwards**: which evidence to preserve.

An alert without a runbook should be downgraded to a ticket; don't wake anyone up for it.

## Cost and token alerts

Beyond availability, cost deserves its own alerts:

```promql
# A single tenant's hourly cost exceeds 5x its daily average
sum by (tenant) (increase(gateway_cost_usd_total[1h]))
>
5 * avg_over_time(sum by (tenant) (increase(gateway_cost_usd_total[1h] offset 1d))[7d:1h])
```

And token-level anomalies:

- A single request's output tokens exceed 10x P99 → likely a runaway loop or a prompt problem.
- Input tokens suddenly double → the context assembly logic changed.
- The share of `usage_source="estimated"` rises → upstream usage fields are unreliable and the books are less trustworthy.

## Anti-patterns

| Anti-pattern | Problem |
| --- | --- |
| Paging P1 for every exception | Alert fatigue; real incidents get buried |
| Alerts without runbooks | On-call can only guess |
| Alerting on cause metrics (e.g. "retries > 10") | Successful retries are invisible to users, yet wake you nightly |
| Synchronous span export | Latency collapse at peak |
| Streaming span ends early | The generation phase is completely invisible |
| Collector without a memory limit | OOM drops all signals together |
| Redaction by regex only | Names, addresses and internal codenames still leak |
| Sampling away errors | No evidence when the incident happens |

## Checklist

- [ ] OTLP is the single egress; the backend is replaceable
- [ ] Upstream spans use the GenAI semantic conventions plus `lgw.*` attributes
- [ ] Streaming spans end at the last byte; TTFT is recorded as an event
- [ ] `BatchSpanProcessor` is enabled and drop volume is monitored
- [ ] The Collector configures `memory_limiter`, `batch` and tail sampling
- [ ] Sensitive headers and prompts are deleted along the collection path
- [ ] Alerts are symptom-based, each with a duration and a severity
- [ ] SLOs use multi-window burn rates, not single thresholds
- [ ] P1/P2 alerts link to a runbook
- [ ] Inhibition rules keep one incident from flooding the channel
- [ ] Cost and `usage_source` anomalies have dedicated alerts

## Next

That completes observability. Now for practice: start with the most common scenario, [multi-vendor routing and automatic failover](../04-scenarios/multi-vendor-failover.md).
