---
layout: home

hero:
  name: LLM Gateway Patterns
  text: Production patterns for LLM gateways
  tagline: Turn “we can call a model API” into “we can survive traffic, cost and failures in production.” Written for backend engineers, AI platform teams and agent builders.
  image:
    light: /hero-light.svg
    dark: /hero-dark.svg
    alt: Apps and agents reaching OpenAI, Claude and Gemini through an LLM gateway
  actions:
    - theme: brand
      text: Start reading
      link: /en/00-introduction/why-gateway
    - theme: alt
      text: Run the minimal gateway
      link: /en/01-basics/minimal-python
    - theme: alt
      text: GitHub
      link: https://github.com/yuxinrun/llm-gateway-patterns

features:
  - title: Patterns over API reference
    details: Every pattern covers when to use it, what usually goes wrong, a rollout checklist and runnable code.
    link: /en/02-production/routing
    linkText: Production patterns
  - title: Python + TypeScript demos
    details: Two minimal gateways in about a hundred lines. See streaming work first, then add capabilities as you need them.
    link: /en/01-basics/minimal-python
    linkText: Run a gateway
  - title: A field guide to failures
    details: SSE drops, 429s, cache poisoning, long context and canary rollbacks, each with a triage order.
    link: /en/05-debugging/common-issues
    linkText: Troubleshooting
  - title: Cost and caching together
    details: Token billing, tenant invoices, prompt/KV cache hit rates and budget alerts. Measure it before you scale it.
    link: /en/02-production/cost
    linkText: Track cost
  - title: Close the observability loop
    details: Trace IDs from the upstream agent to the model call, plus OpenTelemetry, Prometheus and alert rules.
    link: /en/03-observability/metrics
    linkText: Build dashboards
  - title: Built for agents and MCP
    details: Pairs with better-agent and mcp-patterns. The gateway is a governance boundary, not just a reverse proxy.
    link: /en/04-scenarios/better-agent
    linkText: Ecosystem wiring
---

<HomeEcosystem />

<HomeChapters />

## The short version

> **A gateway is not “one more proxy”. It is a controllable boundary around an unreliable, expensive, fast-moving dependency.**
>
> One API, isolated keys, controlled cost, contained failures. If any one of those hurts today, keep reading.

### Three ways to read

| Your situation | Start here | What you get |
| --- | --- | --- |
| Connecting your first model | [Minimal gateway in Python](./01-basics/minimal-python.md) | A runnable proxy, SSE passthrough, normalized errors |
| Timeouts or 429s in production | [Retries, breakers and fallbacks](./02-production/resilience.md) | Retry policy, circuit states, fallback chains |
| Several teams sharing one budget | [Enterprise multi-tenancy](./04-scenarios/multi-tenant.md) | Tenant quotas, key isolation, invoice split |
| Building an agent platform | [Wiring into better-agent](./04-scenarios/better-agent.md) | Model aliases, cost attribution, tracing |

### Conventions

- Demos use **Python 3.11+ / FastAPI / httpx** and **Node.js 20+ / Hono** for TypeScript.
- Code favors “runnable and changeable” over “complete platform”. Use the checklists at the end of each chapter before going live.
- Prices and quota numbers are examples for the math only. Always check current vendor pricing and terms.
- Vendor names and endpoint paths are technical references, not recommendations.

### What this site is not

It does not replace official API docs, teach your first prompt, or promise “every model supported”. It answers one question: **what must be engineered before model calls are production-ready.**
