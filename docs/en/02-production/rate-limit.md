---
title: "Rate Limits and Quotas: RPM/TPM Tiers"
description: Rate-limiting models for RPM, TPM, concurrency, and budget, a distributed token bucket implementation, and tiered tenant quotas.
---

# Rate Limits and Quotas: RPM/TPM Tiers

Rate limiting is not "rejecting users"; it is **allocating finite model capacity to the people who matter most**. Without it, a single script can make the whole platform return 429.

## Five dimensions to separate first

| Dimension | What it governs | Typical scenario |
| --- | --- | --- |
| RPM | Requests per minute | Stops a flood of small requests from exhausting connections |
| TPM | Tokens per minute | Stops long contexts from eating the upstream quota |
| Concurrent streams | Streaming requests in flight | Stops connections and VRAM from being exhausted |
| Daily/monthly budget | Money or total tokens | Stops runaway usage and billing incidents |
| Tool/task quota | Calls per agent run | Stops an agent loop from spiraling |

RPM alone misses "one request with a million tokens"; TPM alone misses "a flood of empty requests holding connections". **RPM + TPM + concurrency** is the minimum combination.

## Choosing an algorithm

| Algorithm | Pros | Cons | Fits |
| --- | --- | --- | --- |
| Fixed window | Simplest to implement | Double bursts at window boundaries | Coarse protection |
| Sliding window log | Exact | Memory grows with request volume | Low-volume exact counting |
| Sliding window counter | Balances accuracy and memory | Still approximate | General API rate limiting |
| Token bucket | Allows controlled bursts | Parameters need tuning | Model call entry points |
| Leaky bucket | Smooth output | No bursts allowed | Protecting fragile upstreams |

Recommendation: **token bucket at the entry point (short bursts allowed), sliding window or cumulative counters for budgets, and semaphores for concurrency**.

### Distributed token bucket

With multiple replicas, counters cannot live in process memory. The Redis Lua below makes "read, compute, write" atomic:

```lua
-- KEYS[1] = bucket key
-- ARGV[1] = capacity, ARGV[2] = refill tokens/sec
-- ARGV[3] = now ms, ARGV[4] = cost
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(data[1]) or capacity
local ts = tonumber(data[2]) or now
local delta = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + delta * rate)

local ttl = math.ceil(capacity / rate * 1000) + 1000

if tokens < cost then
  redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
  redis.call("PEXPIRE", KEYS[1], ttl)
  return {0, math.floor(tokens), math.ceil((cost - tokens) / rate)}
end

tokens = tokens - cost
redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
redis.call("PEXPIRE", KEYS[1], ttl)
return {1, math.floor(tokens), 0}
```

The Python side:

```python
import time
from redis.asyncio import Redis

LUA = """...the script above..."""

class TokenBucket:
    def __init__(self, redis: Redis, capacity: int, refill_per_sec: float):
        self.redis = redis
        self.capacity = capacity
        self.refill = refill_per_sec
        self.script = redis.register_script(LUA)

    async def acquire(self, key: str, cost: int = 1) -> tuple[bool, int, int]:
        allowed, remaining, retry_after = await self.script(
            keys=[key],
            args=[self.capacity, self.refill, int(time.time() * 1000), cost],
        )
        return bool(allowed), int(remaining), int(retry_after)
```

::: tip How to pick the parameters
`capacity` is the allowed burst, `refill` is the long-term rate. For RPM=600, use `capacity=100` and `refill=10/s`: a 10-second burst is allowed, and the long-term rate stays under 600 per minute.
:::

## How to count TPM without losing

Unlike request counts, **you do not know at request start how much will be generated**. Use "reserve + settle":

1. Estimate input tokens (tokenizer or a conservative character ratio);
2. Reserve `input + max_tokens`;
3. After the upstream responds, settle the difference against the real usage;
4. Release the reservation for failed requests.

```python
def estimate_tokens(text: str) -> int:
    # Rough estimate: about 4 characters per token for English, about 1.5 for Chinese
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    other_chars = len(text) - ascii_chars
    return max(1, ascii_chars // 4 + int(other_chars / 1.5))
```

::: warning Estimates are for reserving only, never for billing
Billing must prefer the usage returned by the upstream. Estimates are only for rate-limit pre-checks, with a 10%–20% safety margin.
:::

### How to count cached tokens

After a Prompt Cache hit the upstream bills at a discount, but **your quota policy does not have to follow that discount**:

- If the quota is a "cost ceiling": count the discounted cost;
- If the quota is "resource consumption": count the original tokens so users cannot abuse long prefixes.

Both are reasonable; the point is to write it into the product rules instead of letting the implementation decide quietly.

## Tenant tiers

A typical three-level structure:

```text
Organization (company)
  └── Project (business unit / environment)
        └── API Key (service / developer)
```

Recommended effective quota:

```text
effective_limit = key_override
                ?? project_limit
                ?? org_limit
                ?? plan_default
```

| Plan | RPM | TPM | Concurrent streams | Daily budget | Notes |
| --- | --- | --- | --- | --- | --- |
| Free | 60 | 60k | 5 | $5 | Trial |
| Pro | 600 | 600k | 50 | $100 | Small teams |
| Enterprise | Custom | Custom | Custom | Custom | Dedicated pool / dedicated instances |

::: warning Quota inheritance must override, not add
Parent at 1M TPM and child project at 100k TPM: the child should get 100k, not 1.1M. Write the inheritance rules down explicitly and visualize them in the admin console.
:::

## What a 429 should return

Returning only `{"error":"too many requests"}` leaves the client with nothing but blind retries. Include actionable information:

```http
HTTP/1.1 429 Too Many Requests
retry-after: 2
x-ratelimit-limit-requests: 600
x-ratelimit-remaining-requests: 0
x-ratelimit-reset-requests: 2s
x-ratelimit-limit-tokens: 600000
x-ratelimit-remaining-tokens: 12000
x-ratelimit-reset-tokens: 8s
```

```json
{
  "error": {
    "message": "Tenant rate limit exceeded for chat-default.",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded",
    "request_id": "req_...",
    "retryable": true
  }
}
```

Distinguish two kinds of 429:

- `rate_limit_exceeded`: short-term rate limiting, retry with backoff;
- `quota_exceeded`: the period budget is gone, retrying is pointless; upgrade the plan or wait for the next period.

## Concurrent streams and queues

Streaming requests hold connections for a long time. Limit concurrency at two levels:

1. **Tenant-level semaphore**: stops one tenant from taking everything;
2. **Upstream target-level semaphore**: protects a specific vendor or model.

```python
import asyncio

class ConcurrencyLimiter:
    def __init__(self, limit: int):
        self.sem = asyncio.Semaphore(limit)

    async def run(self, coro, queue_timeout: float = 0.5):
        try:
            await asyncio.wait_for(self.sem.acquire(), timeout=queue_timeout)
        except asyncio.TimeoutError as exc:
            raise GatewayError(429, "concurrency_exceeded", "Too many in-flight streams.", True) from exc
        try:
            return await coro()
        finally:
            self.sem.release()
```

Do not set the queue timeout too high: waiting 30 seconds before generation starts is bad for both user experience and cost.

## Upstream rate limits matter too

Your own quota is "how much users may use"; the upstream RPM/TPM is "how much the vendor allows you". Take the smaller of the two:

```text
effective = min(tenant_quota, provider_quota / replica_count, adaptive_limit)
```

Adaptive concurrency can use AIMD:

- Consecutive successes: raise the concurrency ceiling slowly (+1);
- On 429 or timeout: halve it and enter cooldown;
- Do not raise it during cooldown.

This adapts to the upstream's real capacity better than a fixed limit.

## Anti-patterns

::: danger Every replica counts on its own
3 replicas at 600 RPM each is really 1,800 RPM. Either use Redis or divide the quota by the number of replicas.
:::

::: danger Limiting requests but not tokens
One 200k-token request can be more expensive and slower than 100 small ones.
:::

::: danger Fixed windows at the boundary
600 requests at second 59 and another 600 at second 61: the upstream receives 1,200 in two seconds.
:::

::: danger Retrying immediately after a 429
Retries without backoff or jitter turn rate limiting into an avalanche. Retries must consume the retry budget.
:::

::: danger Treating quota as billing
Quota is "are you allowed"; billing is "how much do you owe". They can be related, but never conflated.
:::

## Checklist

- [ ] All four dimensions have policies: RPM, TPM, concurrency, and budget
- [ ] Counters are updated atomically in distributed storage
- [ ] TPM uses "reserve + settle" with a safety margin
- [ ] Quota hierarchy supports overriding and is visible in the console
- [ ] 429 responses carry `Retry-After` and quota headers
- [ ] Short-term rate limiting is distinguished from period quota
- [ ] Streaming concurrency is limited per tenant and per target
- [ ] Upstream 429s trigger backoff instead of blind retries
- [ ] Fail-open / fail-closed behavior is explicit when Redis fails

Next: [Auth isolation and multi-tenancy](./auth-tenant.md), which answers "who are you and what can you use".
