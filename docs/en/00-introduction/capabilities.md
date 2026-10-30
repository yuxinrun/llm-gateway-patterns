---
title: Core gateway capability checklist
description: A four-level capability model from transparent proxy to platform, plus the minimum launch set and a 90-day rollout plan.
---

# Core gateway capability checklist

The most common gateway mistake is not missing a feature; it is **building too much at once**. This chapter gives you a capability map to use in stages.

## The four-level capability model

| Level | Name | Keyword | Typical capabilities |
| --- | --- | --- | --- |
| L0 | Transparent proxy | It works | Request forwarding, key custody, request id, health checks |
| L1 | Operable | Nothing runs away | Auth, timeouts, error normalization, rate limiting, structured logs |
| L2 | Governable | Schedulable | Routing, fallback, caching, cost attribution, traces, metrics |
| L3 | Platform | Run as a business | Multi-tenancy, billing, canary, audit, self-service onboarding |

Most teams should first get **L1 complete + the two key L2 items** (routing and observability), then talk about L3. The usual cost of skipping levels: the features exist, but the data is wrong, failures cannot be localized, and nobody dares to use it.

## Capability map

### Access and protocol

- [ ] OpenAI Chat Completions compatible entry point
- [ ] Both streaming (SSE) and non-streaming supported
- [ ] Adapters for at least two vendors
- [ ] Tool call (tools / tool_calls) field mapping
- [ ] Request validation: `messages`, `model`, `max_tokens` boundaries
- [ ] Model aliases (clients do not depend on vendor model names directly)

### Governance and security

- [ ] Gateway key issuance, rotation, revocation
- [ ] Tenant / project / key three-level identity
- [ ] Model allowlists and routing tag permissions
- [ ] RPM, TPM, concurrency, daily/monthly budget
- [ ] Request body size, message count and max token limits
- [ ] Log redaction; keys and prompts off disk by default

### Reliability

- [ ] Four timeout types: connect / first token / idle / total
- [ ] Retryable error classification and exponential backoff
- [ ] Circuit breaking and half-open probes
- [ ] Fallback model chain (capability-aligned, not blind downgrade)
- [ ] Graceful shutdown and streaming connection draining
- [ ] Health checks that separate liveness / readiness

### Cost and caching

- [ ] Precise metering from usage fields
- [ ] Estimation fallback when streaming usage is missing
- [ ] Attribution by tenant / project / model / feature
- [ ] Budget alerts and hard-stop policies
- [ ] Exact cache and cache invalidation
- [ ] Prompt / KV cache hit statistics

### Observability

- [ ] Structured JSON logs + request id
- [ ] W3C trace context propagation
- [ ] TTFT, total latency, error rate, retry rate metrics
- [ ] Cache hit rate, token consumption, unit cost
- [ ] Per-target upstream health metrics
- [ ] Alert rules and an on-call runbook

### Operations

- [ ] Stateless deployment and horizontal scaling
- [ ] Config hot reload and rollback
- [ ] Secrets separated from config (Secret Manager)
- [ ] Canary / progressive rollout
- [ ] Capacity model and load-test baseline
- [ ] Backup and disaster recovery

## Minimum launch set (MVP)

If you only build the first version, these 10 things are enough:

1. **OpenAI-compatible entry point** + streaming passthrough.
2. **Request id** across logs, response headers and upstream requests.
3. **Real keys consolidated**; clients only get gateway keys.
4. **Four timeout types**, especially first-token timeout.
5. **Error normalization**: upstream errors mapped to stable error codes.
6. **Basic quotas**: RPM + daily budget per key.
7. **One backup model** + a configurable fallback chain.
8. **Structured logs** that do not record prompts by default.
9. **Three metrics**: TTFT / error rate / token usage.
10. **Health checks + multiple replicas**.

Only after these 10 are done does the gateway deserve to be called a "production entry point" rather than "one more proxy layer".

## 90-day rollout plan

| Time | Goal | Deliverable |
| --- | --- | --- |
| Week 1–2 | It runs | Minimal gateway, two models, streaming, request id |
| Week 3–4 | Controllable | Auth, key lifecycle, basic rate limiting, error codes |
| Week 5–6 | Observable | JSON logs, traces, TTFT/error-rate dashboards |
| Week 7–8 | Schedulable | Model aliases, weighted routing, fallback chain, circuit breaker |
| Week 9–10 | Books that add up | Usage metering, tenant attribution, budget alerts |
| Week 11–12 | Drillable | Load tests, fault injection, canary, on-call runbook |

This table assumes 1–2 engineers. With fewer people, stretch it out; do not compress "observability" and "drills" — they are the acceptance criteria for every capability that follows.

## Self-assessment scorecard

For selection or acceptance, you can score by weight (1–5):

| Dimension | Weight | Notes |
| --- | --- | --- |
| Protocol compatibility | 20% | Can SDKs connect without changes |
| Stability | 20% | Timeouts, retries, circuit breaking, streaming error handling |
| Tenancy and quotas | 15% | Hierarchy, inheritance, over-limit behavior |
| Cost and billing | 15% | Usage accuracy, attribution dimensions, budgets |
| Observability | 15% | Traces, metrics, logs, alerts |
| Extensibility | 10% | Customization, config hot reload |
| Operational cost | 5% | Deployment, upgrades, on-call |

::: tip How to score
Set red lines for veto items first, then compute the total. If "must split bills by tenant" is not met, do not pick it no matter how well it scores elsewhere.
:::

## Common anti-patterns

::: danger Protocol translation only
Requests get forwarded, but there are no timeouts, quotas or metering. After launch, every problem is still handled separately by each business system.
:::

::: danger Quotas only in memory
Per-instance counters look fine, then break as soon as you scale replicas; a restart resets them, and users can "freeload" quota during a release window.
:::

::: danger Writing prompts into logs
Great for debugging, thorough for leaks. Redact by default, sample on demand, and set a retention period. That is the baseline.
:::

::: danger Fallback models that are not capability-aligned
The primary model supports tool calls and the backup does not, so the agent crashes the moment you switch. Match fallback chains by capability tags.
:::

::: danger No request id
Upstream says 500, the gateway says 502, the business says timeout, and the three sides do not line up. One request id that spans the chain can save half your debugging time.
:::

## Acceptance checklist

Before launch, validate with these five questions:

- [ ] Pick any failed request: can you pinpoint "which tenant, which target, which error class" within 5 minutes?
- [ ] Turn off the primary model: does the system switch to the backup as expected and leave clear logs?
- [ ] When one tenant suddenly maxes out its quota, does it affect only that tenant?
- [ ] Can the bill be split by tenant and reconciled against vendor bills at the same order of magnitude?
- [ ] When you release a new gateway version, can streaming requests drain gracefully?

Next, get hands-on: [Minimal viable gateway (Python)](../01-basics/minimal-python.md).
