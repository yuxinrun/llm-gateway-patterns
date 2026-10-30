---
title: LiteLLM Advanced Configuration Template
description: A working config.yaml for multi-model routing, virtual keys, budgets, fallbacks, and observability, plus how to decide when to build your own.
---

# LiteLLM Advanced Configuration Template

LiteLLM is the fastest way to get started among open-source gateways: one YAML file connects dozens of providers, with virtual keys, budgets, fallbacks, and logging callbacks built in. But it is not a silver bullet. Once your requirements go beyond its abstraction boundaries, the cost of adapting it rises quickly.

This page gives you a production-leaning configuration template and explains which capabilities you can use as-is and which need custom development.

::: tip Version differences
LiteLLM iterates quickly, and configuration fields may change between versions. The template below follows common Proxy configuration. Validate it against the docs for your version before deploying.
:::

## The bottom line

- **LiteLLM is a good fit when you need "a working multi-model gateway quickly"**, especially when your team has no dedicated platform engineering.
- **Production must use Postgres**, or virtual keys, budgets, and spend exist only in memory.
- **Choose the routing strategy per scenario**; do not ship with the default `simple-shuffle`.
- **Distinguish "same context window" from "larger window" in fallbacks**, or long requests will still fail after switching.
- **Redis is required for multi-replica deployments**, for routing state, caching, and rate limiting.
- **When you need deep customization (special auth, complex billing, private protocols), building your own or forking is the better deal.**

## Use as-is vs. build

| Capability | LiteLLM today | Recommendation |
| --- | --- | --- |
| Multi-provider access | Broad coverage, mature adapters | Use as-is |
| OpenAI-compatible API | Complete | Use as-is |
| Virtual keys / teams / budgets | Built in | Use as-is, with Postgres |
| Routing and fallbacks | Multiple built-in strategies | Use as-is, configured per scenario |
| Caching | Redis / semantic cache supported | Exact cache works as-is |
| Observability | OTel / Prometheus / Langfuse callbacks | Use as-is |
| Custom auth | Hooks exist, but extensibility is limited | Depends on complexity |
| Special billing (tiers, contract pricing) | Needs custom callbacks | Secondary development |
| Private protocols / non-HTTP upstreams | Not supported | Build an adapter layer |

## Deployment options

```bash
# Simplest: pip
pip install "litellm[proxy]"
litellm --config config.yaml --port 4000

# Docker
docker run -d --name litellm \
  -p 4000:4000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -e LITELLM_MASTER_KEY=$MASTER_KEY \
  -e DATABASE_URL=$DATABASE_URL \
  ghcr.io/berriai/litellm:main-stable \
  --config /app/config.yaml
```

Production recommendations:

- Pin the image tag; do not use `main`.
- Run Prisma migrations in a separate migration container.
- Run at least 2 replicas behind a reverse proxy that supports SSE.

## config.yaml template

```yaml
model_list:
  # ---------- OpenAI ----------
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o-2024-08-06
      api_key: os.environ/OPENAI_API_KEY
      rpm: 3000
      tpm: 2000000
      weight: 70
    model_info:
      mode: chat
      supports_function_calling: true
      supports_vision: true
      max_input_tokens: 128000

  - model_name: gpt-4o-mini
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY
      rpm: 6000
      weight: 100
    model_info:
      supports_function_calling: true
      max_input_tokens: 128000

  # ---------- Anthropic ----------
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: os.environ/ANTHROPIC_API_KEY
      rpm: 1000
      weight: 30
    model_info:
      supports_function_calling: true
      supports_vision: true
      max_input_tokens: 200000

  # ---------- Chinese providers ----------
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      rpm: 2000
      weight: 0        # fallback only
    model_info:
      supports_function_calling: true
      max_input_tokens: 64000

  - model_name: qwen-max
    litellm_params:
      model: dashscope/qwen-max
      api_key: os.environ.DASHSCOPE_API_KEY
      rpm: 1000
      weight: 0
    model_info:
      supports_function_calling: true
      max_input_tokens: 32000

  # ---------- Self-hosted ----------
  - model_name: local-qwen
    litellm_params:
      model: openai/qwen2.5-72b-instruct
      api_base: http://vllm:8000/v1
      api_key: os.environ/LOCAL_KEY
      rpm: 500
    model_info:
      supports_function_calling: true
      max_input_tokens: 32000

router_settings:
  routing_strategy: usage-based-routing-v2
  num_retries: 2
  timeout: 120
  allowed_fails: 3
  cooldown_time: 30
  enable_pre_call_checks: true

  redis_host: os.environ/REDIS_HOST
  redis_port: 6379
  redis_password: os.environ/REDIS_PASSWORD

  fallbacks:
    - gpt-4o: ["claude-sonnet", "deepseek-chat"]
    - claude-sonnet: ["gpt-4o", "qwen-max"]
    - gpt-4o-mini: ["deepseek-chat"]

  context_window_fallbacks:
    - gpt-4o: ["claude-sonnet"]
    - deepseek-chat: ["claude-sonnet"]

litellm_settings:
  drop_params: true
  request_timeout: 120
  num_retries: 2
  cache: true
  cache_params:
    type: redis
    host: os.environ/REDIS_HOST
    port: 6379
    password: os.environ/REDIS_PASSWORD
    ttl: 3600
    supported_call_types: ["acompletion"]
  success_callback: ["prometheus", "otel"]
  failure_callback: ["prometheus", "otel"]
  max_budget: 5000
  budget_duration: 30d

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  store_model_in_db: true
  proxy_batch_write_at: 10
  alerting: ["slack"]
  alerting_threshold: 300
```

### Key fields explained

| Field | Purpose | Watch out |
| --- | --- | --- |
| `weight` | Traffic share across deployments under the same `model_name` | Set to 0 to use the deployment only as a fallback |
| `rpm` / `tpm` | Quota for that deployment | Used for pre-call checks and rate limiting |
| `routing_strategy` | Algorithm for picking a deployment | See the next section |
| `num_retries` | Retries per request | Stacks with retries on the application side |
| `allowed_fails` | Failures before cooldown kicks in | Too low causes frequent circuit breaking |
| `cooldown_time` | Cooldown in seconds | Raise it when upstreams recover slowly |
| `enable_pre_call_checks` | Filter out unsuitable deployments before forwarding | Recommended |
| `drop_params` | Drop parameters the upstream does not support | Avoids 400s but changes behavior silently |
| `context_window_fallbacks` | Fallbacks when the context limit is exceeded | Keep separate from regular fallbacks |

::: warning The two sides of `drop_params: true`
It prevents many "this parameter is not supported" 400s, but it also **silently drops** parameters you depend on (such as `response_format`). After enabling it, cover critical parameters in your tests to confirm behavior matches expectations.
:::

## Choosing a routing strategy

| Strategy | Behavior | Use when |
| --- | --- | --- |
| `simple-shuffle` | Random by weight | Deployments are homogeneous and you want simplicity |
| `least-busy` | Pick the lowest current concurrency | Request durations vary widely |
| `usage-based-routing-v2` | Pick by remaining TPM/RPM | You have hard quota ceilings |
| `latency-based-routing` | Pick the lowest historical latency | Experience comes first |

For long streaming requests, `least-busy` or `usage-based-routing-v2` is usually more stable than random, because random tends to pile multiple long requests onto the same deployment.

## Virtual keys and budgets

Create tenants and keys through the management API:

```bash
curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "models": ["gpt-4o-mini", "deepseek-chat"],
    "max_budget": 200,
    "budget_duration": "30d",
    "rpm_limit": 300,
    "tpm_limit": 600000,
    "team_id": "team_support",
    "metadata": {"tenant": "t_1001"}
  }'
```

The returned key works like a regular OpenAI key. Once the budget is exhausted, requests are rejected, and spend data is written to the Postgres you configured.

A few practices:

- **Use `master_key` for administration only**; never hand it to application teams.
- **Set budgets per team or tenant**, not just globally.
- **Reconcile regularly**: compare LiteLLM's spend table against provider invoices.
- **Put tenant information in the key's `metadata`** to make log attribution easier.

## Fallback configuration pitfalls

```yaml
fallbacks:
  - gpt-4o: ["claude-sonnet", "deepseek-chat"]
```

This means "when gpt-4o fails, try these in order". But keep in mind:

1. **Capabilities are not equal**: `deepseek-chat` has a smaller context, so long requests will still fail after switching. Handle that separately with `context_window_fallbacks`.
2. **Tool calling**: fallback targets must support tools, or tool-using requests will fail.
3. **Endless fallback**: a cycle such as A → B → A causes requests to be retried repeatedly. Avoid cycles in your configuration.
4. **Billing attribution**: calls after a fallback are billed at the actual model's rate, but your product may charge at the original model's price. You must be able to account for the difference.

## Observability

LiteLLM supports several callbacks. The minimum production set:

```yaml
litellm_settings:
  success_callback: ["prometheus", "otel"]
  failure_callback: ["prometheus", "otel"]
```

- `prometheus`: exposes `/metrics` for request counts, latency, and spend.
- `otel`: exports spans to Tempo/Jaeger.
- Add Langfuse or similar when you need to inspect prompts and responses per request, but watch data compliance.

Whether a callback is **synchronous or asynchronous** depends on the implementation. Under high request rates, prefer async or batched writes so callbacks do not slow down the main path.

## Multi-replica considerations

| Item | Requirement |
| --- | --- |
| Postgres | Shared by all replicas; stores keys, budgets, spend |
| Redis | Shared routing state, cache, rate limiting |
| Migrations | Run by a single job to avoid concurrent migrations |
| Config | Identical on every replica; roll restart or hot reload after changes |
| Clock | NTP-synced, or budget windows drift |
| Session | Do not rely on local memory |

Spend writes in LiteLLM are batched with a delay (`proxy_batch_write_at`), so budgets may briefly overspend across replicas. For budget-sensitive workloads, shorten the batch window or add another budget check in front.

## Extension points

| Need | Approach |
| --- | --- |
| Custom log fields | CustomLogger callback |
| Custom routing | Custom Router or a fronting service |
| Special auth | Custom auth hook |
| Request/response rewriting | guardrail / callback |
| Private provider | Custom provider adapter |

If you need more than three changes, reconsider: keep forking, or treat LiteLLM as an upstream and put a lightweight gateway in front of it. The long-term cost of a fork (merge conflicts, lagging upgrades) is often underestimated.

## Building your own vs. LiteLLM

| Dimension | LiteLLM | Built in-house |
| --- | --- | --- |
| Time to launch | Days | Weeks to months |
| Provider coverage | Broad | As needed |
| Customization | Medium | High |
| Performance tuning | Constrained by the framework | Fully under your control |
| Upgrade risk | Follow upstream | On you |
| Special billing | Requires development | Native |
| Team cost | Low | High |

The test: **if your core differentiation is "breadth and speed of model integration", use LiteLLM; if it is "billing, isolation, protocol, performance", building your own or a hybrid fits better.**

A hybrid is also common: LiteLLM as the upstream adapter layer, with your own gateway in front handling auth, quotas, billing, and routing decisions.

## Migration path

Moving from direct connections to LiteLLM:

1. Build a `model_list` with the same model names.
2. Change only `base_url` and the key in your applications.
3. Turn on logging and compare tokens and cost on both sides.
4. Enable fallbacks, caching, and budgets incrementally.
5. Watch for a week before retiring the direct connections.

Do not cut over all traffic at once. Start with one non-critical service and verify that billing and streaming both work.

## Anti-patterns

| Anti-pattern | Consequence |
| --- | --- |
| No Postgres | Keys and budgets are lost on restart |
| Using the `main` image | Incompatible changes can land at any time |
| Setting `weight: 0` but expecting random selection | Fallback targets never take regular traffic |
| A cyclic fallback chain | Requests are retried endlessly |
| Only a global budget | A single tenant can burn the entire allowance |
| Enabling `drop_params` without tests | Critical parameters are dropped silently |
| Multiple replicas without shared Redis | Routing and cache state diverge |
| Synchronous callbacks | Peak traffic slows the main path |

## Checklist

- [ ] Image version pinned and migrations run separately
- [ ] Postgres connected, virtual keys and spend persisted
- [ ] Redis shared across replicas
- [ ] Routing strategy chosen by request characteristics, not the default random
- [ ] Fallback chain is capability-matched and acyclic, with long context configured separately
- [ ] `enable_pre_call_checks` enabled
- [ ] Budgets set per team or tenant, not only globally
- [ ] Critical parameters tested with `drop_params` enabled
- [ ] Observability callbacks are async and data is compliant
- [ ] Long-term cost of building or forking evaluated
- [ ] Migration rolled out per service, verifying billing and streaming first

## Next

The last page covers how upper-layer frameworks connect: [LangGraph / CrewAI / Dify integration](./langgraph-crewai-dify.md).
