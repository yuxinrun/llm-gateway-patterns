---
title: Load Testing and Bottleneck Hunting
description: How to load-test streaming model calls, with mock upstreams, step ramps, knee detection and a checklist of common bottlenecks.
---

# Load Testing and Bottleneck Hunting

"We load-tested at 500 QPS without a problem, then production fell over at 50 QPS." Incidents like this are rarely the tool's fault. The load test measured the **wrong object**: the upstream was mocked with zero latency, only short requests were exercised, or streaming long-lived connections were never tested.

Load-testing an LLM gateway differs fundamentally from load-testing an ordinary CRUD API. Copying a traditional approach gives you a nice-looking set of numbers that mean nothing.

## The short version

- **Test in three layers**: the gateway itself, end to end (including real upstream quota), and failure scenarios.
- **You must test streaming**. A streaming request occupies a connection tens of times longer than an ordinary request.
- **A mock upstream measures gateway capacity; a real upstream measures quota and end-to-end experience.** Do not mix the two.
- **Look for the knee, not the maximum**. Past the knee, every additional bit of load makes latency and error rate climb steeply.
- **Watch connection count, file descriptors, memory and event loop lag**. They expose problems earlier than QPS does.
- **The load-test environment must match production**: same replica count, proxies, timeouts and rate-limit configuration.

## The three layers of load testing

| Layer | Upstream | Question it answers | Risk |
| --- | --- | --- | --- |
| Gateway capacity | Mock with controllable latency | How much concurrency can one replica handle? | Ignores real upstream variance |
| End to end | Real upstream | What does the user actually experience? | Constrained by quota, expensive |
| Failure scenarios | Mock + fault injection | Do degradation, circuit breaking and retries work? | Configuration may differ from production |

Most teams only do the second layer. As a result they cannot push load high (the upstream returns 429) and they never learn the gateway's own limit. The right order is: use a mock to push the gateway to its knee, use the real upstream to validate end to end, then do fault injection.

## How this differs from ordinary API load testing

| Difference | Impact |
| --- | --- |
| Streaming long-lived connections | A connection is held 10-100x longer than for an ordinary request |
| Variable response size | Bandwidth differs wildly at the same QPS |
| Upstream quota | A load test can exhaust production quota outright |
| Non-determinism | Identical requests take different times, with high variance |
| Token billing | The load test itself costs money |
| Connection pool sensitivity | A small pool queues, a large pool overwhelms the upstream |

The last row is the one most often missed: many "the gateway is slow" problems are really caused by the `httpx` connection pool's default limit being too small, so requests queue in the pool rather than wait on the upstream.

## Types of load test

| Type | Purpose | Duration | Pass criteria |
| --- | --- | --- | --- |
| Baseline | Latency baseline for a single request | Minutes | P50/P95/P99 |
| Step ramp | Find the knee | 30-60 minutes | Latency knee, error-rate knee |
| Soak | Memory leaks, connection leaks | 2-24 hours | Memory curve, FD count |
| Spike | Burst traffic | Minutes | Rate limiting engages, no cascading failure |
| Fault injection | Degradation paths | Minutes | Circuit breaking, failover, recovery |

### Designing a step ramp

```text
Stage 1: 10 concurrent  x 5 minutes
Stage 2: 50 concurrent  x 5 minutes
Stage 3: 100 concurrent x 5 minutes
Stage 4: 200 concurrent x 5 minutes
Stage 5: 400 concurrent x 5 minutes
```

Leave 1-2 minutes between stages to observe recovery. Signals that you have hit the knee:

- P95 latency exceeds 2x the baseline.
- Error rate exceeds 1%.
- Event loop lag keeps rising.
- Connection pool wait time rises.
- CPU reaches 80% but throughput stops growing.

**The knee is your safe capacity.** Set alerts and scale-out thresholds at 60-70% of the knee.

## Mock upstream

The mock must reproduce the key characteristics of a real upstream, not just return 200:

```python
import asyncio
import json
import time

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

TTFT_MS = 300
TOKEN_INTERVAL_MS = 20
TOKENS = 200


@app.post("/v1/chat/completions")
async def chat(body: dict):
    if not body.get("stream"):
        await asyncio.sleep((TTFT_MS + TOKEN_INTERVAL_MS * TOKENS) / 1000)
        return {
            "id": "mock-1",
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "x" * 400}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": TOKENS, "total_tokens": 100 + TOKENS},
        }

    async def gen():
        await asyncio.sleep(TTFT_MS / 1000)
        for i in range(TOKENS):
            chunk = {
                "id": "mock-1",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"content": "x"}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            await asyncio.sleep(TOKEN_INTERVAL_MS / 1000)
        yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":200}}\n\n'
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
```

This mock reproduces three important things: time to first token, generation speed, and how long a streaming connection stays occupied. If your gateway cannot hold up against the mock, the problem is definitely in the gateway itself.

Add a failure switch as well:

```python
FAIL_RATE = 0.0   # injected via environment variable

@app.middleware("http")
async def inject_failure(request, call_next):
    if random.random() < FAIL_RATE:
        return JSONResponse({"error": {"message": "mock 503"}}, status_code=503)
    return await call_next(request)
```

## Load-testing streams with k6

k6 supports SSE natively, but you have to parse it yourself:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const ttft = new Trend('ttft_ms');
const tokens = new Counter('tokens_total');

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '2m', target: 200 },
        { duration: '5m', target: 200 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    ttft_ms: ['p(95)<2000'],
  },
};

export default function () {
  const payload = JSON.stringify({
    model: 'chat-default',
    stream: true,
    messages: [{ role: 'user', content: 'Write a 200-word explanation' }],
  });

  const start = Date.now();
  let first = true;
  let count = 0;

  const res = http.post('http://gateway:8000/v1/chat/completions', payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${__ENV.GW_KEY}`,
    },
    timeout: '120s',
  });

  // k6's http.post waits for the full response, so strictly speaking it is unsuitable for streaming.
  // For a real streaming client, use k6's experimental websockets/grpc or a custom xk6 extension.
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
```

::: warning k6's streaming limitation
k6's `http` module buffers the full response, so `ttft_ms` cannot be measured accurately. To load-test real streaming, choose one of:

- Write a client with a custom `xk6` extension or in Go.
- Use Locust with `gevent` and the `requests` streaming API.
- Write your own load generator with Python `asyncio` + `httpx` (the most flexible option).

Do not infer streaming capacity from the QPS of a generic HTTP load-testing tool. The two differ by an order of magnitude.
:::

### A Python streaming load generator

```python
import asyncio
import time

import httpx


async def one_request(client: httpx.AsyncClient, url: str, key: str) -> dict:
    start = time.perf_counter()
    ttft = None
    chunks = 0
    async with client.stream(
        "POST",
        url,
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": "chat-default",
            "stream": True,
            "messages": [{"role": "user", "content": "Write a 200-word explanation"}],
        },
        timeout=120.0,
    ) as resp:
        async for line in resp.aiter_lines():
            if line.startswith("data: ") and line != "data: [DONE]":
                if ttft is None:
                    ttft = (time.perf_counter() - start) * 1000
                chunks += 1
    return {
        "status": resp.status_code,
        "ttft_ms": ttft,
        "total_ms": (time.perf_counter() - start) * 1000,
        "chunks": chunks,
    }


async def main(concurrency: int, duration_s: int):
    async with httpx.AsyncClient(
        limits=httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    ) as client:
        end = time.perf_counter() + duration_s
        results = []

        async def worker():
            while time.perf_counter() < end:
                results.append(await one_request(client, "http://localhost:8000/v1/chat/completions", "test"))

        await asyncio.gather(*[worker() for _ in range(concurrency)])
        return results
```

The load generator's own connection pool must be large enough, otherwise you are measuring the generator's bottleneck.

## Bottleneck checklist

Ordered by frequency:

| Bottleneck | Symptom | What to check |
| --- | --- | --- |
| Upstream connection pool too small | High latency, low CPU | `pool` wait, `max_connections` |
| Blocked event loop | Every request slows down together | Event loop lag, synchronous IO |
| Too many Redis round trips | Multiple RTTs per request | Batched checks, pipeline |
| Synchronous logging | CPU spikes at peak | Whether logging blocks writes |
| JSON serialization | High CPU on large responses | `orjson` instead of `json` |
| TLS handshake | New connections are slow | Connection reuse, session reuse |
| DNS | Intermittent timeouts | Caching, `getaddrinfo` duration |
| File descriptors | `Too many open files` | `ulimit -n` |
| Memory | GC pauses, OOM | RSS curve, object allocation |
| Gzip | High CPU, poor TTFT | Compression is usually not worth it for streaming |

### Event loop blocking

The most common invisible killer in Python async services. Any synchronous call stalls the entire loop:

```python
# Bad: blocks the event loop
requests.get(url)
time.sleep(1)
open("big.json").read()

# Good
await client.get(url)
await asyncio.sleep(1)
await asyncio.to_thread(read_file, "big.json")
```

The built-in debug mode surfaces slow callbacks in development:

```bash
PYTHONASYNCIODEBUG=1 uvicorn gateway:app
```

In production, monitor event loop lag (for example, schedule a task once per second and measure the actual delay).

## Capacity estimation

Do a rough calculation with Little's Law:

```text
concurrent requests = arrival rate x average time in system
```

The average time in system for a streaming request can be 10-30 seconds. To sustain 10 QPS of streaming requests at an average of 15 seconds, steady-state concurrency is 150. Those 150 concurrent requests simultaneously hold:

- 150 client connections.
- 150 upstream connections.
- 150 response buffers.
- 150 units of upstream concurrency quota.

Many teams plan capacity purely by QPS and overlook this multiplication.

## Ground rules for load testing

- **Never load-test production.** Even with isolation, you can affect real users and upstream quota.
- **Use a separate upstream key** so load-test traffic does not trip production rate limits.
- **Tag load-test traffic** (`X-Feature: loadtest`) so you can exclude it from billing and monitoring.
- **Start small, grow gradually**, and change only one variable at a time.
- **Record a configuration snapshot**: replica count, timeouts, connection pools, rate-limit parameters. Otherwise results cannot be reproduced.
- **Watch the upstream.** The vendor may rate-limit you because of the load test, which affects other workloads.

## Reading the results

| Observation | Likely cause |
| --- | --- |
| QPS rises, P95 flat | Headroom remains |
| QPS rises, P95 rises linearly | Approaching capacity, queuing has started |
| QPS flat, P95 jumps | The knee has been reached |
| Error rate suddenly rises | Upstream 429 or local resource exhaustion |
| High latency, low CPU | IO wait, connection pool, locks |
| Memory keeps climbing | Leak, unreleased buffers, unclosed connections |
| Latency does not recover after the test | Connection leak, or the upstream is still working |

## Anti-patterns

| Anti-pattern | Consequence |
| --- | --- |
| Load-testing with short requests only | Overestimates capacity several times over |
| Zero-latency mock | Queuing never shows up |
| Watching QPS but not concurrency | Severe misjudgment for streaming |
| Load generator pool too small | You measure the generator |
| Load-testing production | Harms real users and quota |
| Not recording configuration | Results cannot be reproduced |
| Measuring without changing anything | Bottlenecks stay hidden |
| Ignoring upstream quota | The load test becomes an outage drill |

## Checklist

- [ ] Load-test goal is explicit: gateway capacity / end-to-end / failure scenarios
- [ ] Mock upstream includes TTFT, generation speed and stream duration
- [ ] Load test covers streaming and long-context requests
- [ ] Uses a realistic concurrency model instead of reporting QPS only
- [ ] Monitors event loop lag, pool wait, FDs and memory
- [ ] Step ramp finds the knee; capacity is set at 60-70%
- [ ] Load-test traffic is tagged and uses a separate upstream key
- [ ] Full configuration snapshot is recorded for the test
- [ ] Soak test of at least 2 hours has been run
- [ ] Fault injection validates degradation and recovery

## Next

Load testing settles capacity; day-to-day work is mostly specific errors. The final page is the [common issues troubleshooting handbook](./common-issues.md).
