---
title: "Caching Patterns: Responses, KV, and Stampede Protection"
description: How exact response caching, semantic caching, and prompt/KV cache differ, plus cache keys, invalidation, stampede protection, and cost math.
---

# Caching Patterns: Responses, KV, and Stampede Protection

"Just add a cache to the gateway" is a dangerous sentence, because at least four different things are called a cache:

| Layer | What it caches | Hit condition | What it saves | Main risk |
| --- | --- | --- | --- | --- |
| Exact response cache | The full response | Normalized requests are identical | Upstream cost + latency | Data leaking across tenants, stale results |
| Semantic cache | Answers to similar questions | Vector similarity above a threshold | Upstream cost + latency | Answering the wrong question |
| Prompt / KV cache | Prefix KV inside the upstream | The prefix is identical | Input token cost + first token latency | Broken prefix, vendor differences |
| Self-hosted inference KV cache | KV blocks on the GPU | Prefix + the same replica | Compute | VRAM, scheduling complexity |

Discuss them as one thing and you end up with conclusions like "the hit rate won't go up" or "the cache returned someone else's answer". This chapter takes them apart layer by layer.

## 1. Exact response cache

### Which requests can be cached

Not every request qualifies. Require all of the following:

- `temperature == 0` (or the business explicitly accepts deterministic results)
- No personalized context such as user privacy, orders, or sessions
- No tool calls with side effects
- Bounded output length (for example < 8KB)
- The business can tolerate answers that are older than the TTL

::: warning Do not share cache across tenants by default
Even with an identical prompt, the response may contain tenant data. The cache key must include `tenant_id`, or shared caching must be explicitly limited to "public knowledge Q&A".
:::

### How to design the cache key

The key must cover every factor that can change the output:

```python
import hashlib
import json

def response_cache_key(body: dict, tenant_id: str, group: str, prompt_version: str) -> str:
    canonical = {
        "tenant": tenant_id,
        "group": group,
        "prompt_version": prompt_version,
        "model": body["model"],
        "messages": body["messages"],
        "temperature": body.get("temperature", 1.0),
        "top_p": body.get("top_p", 1.0),
        "max_tokens": body.get("max_tokens"),
        "tools": body.get("tools"),
        "response_format": body.get("response_format"),
    }
    raw = json.dumps(canonical, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return "llm:resp:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()
```

A few details:

- `sort_keys=True`: prevents field order from making equivalent requests miss.
- Include `prompt_version`: change the template and old entries expire naturally.
- Include `group`: the same request on different route groups should not share results.
- Do not put the API key or user ID in the key as "pseudo-isolation"; use a tenant namespace.

### Cache writes and stampede protection

The real danger is not a miss, it is a simultaneous miss: the cache just expired, 1,000 requests hit the origin at once, and the upstream goes down.

```python
import asyncio
import random
import json

async def cached_completion(redis, key: str, ttl: int, loader):
    cached = await redis.get(key)
    if cached:
        return json.loads(cached), True

    lock = redis.lock(f"{key}:lock", timeout=30)
    if await lock.acquire(blocking=False):
        try:
            cached = await redis.get(key)      # double-check
            if cached:
                return json.loads(cached), True
            value = await loader()
            # Add jitter to the TTL so entries do not all expire at the same moment
            await redis.set(key, json.dumps(value, ensure_ascii=False), ex=ttl + random.randint(0, 30))
            return value, False
        finally:
            await lock.release()

    # Lost the lock: wait briefly and check again; if still missing, load directly (rate limiting must back this up)
    await asyncio.sleep(0.2)
    cached = await redis.get(key)
    if cached:
        return json.loads(cached), True
    return await loader(), False
```

In production, layer two more mechanisms on top:

1. **In-process singleflight**: within one replica, identical keys trigger only one upstream request;
2. **stale-while-revalidate**: serve the stale value after expiry and refresh asynchronously in the background. Users notice nothing and upstream load is smoothed out.

### How to cache streaming responses

Rule: **cache only responses that completed**, and cap the size.

- Aggregate text while forwarding; write to the cache only after `[DONE]` arrives;
- If the client disconnects mid-stream, do not write (otherwise you cache half an answer);
- On replay, slice at a fixed size and synthesize `data: {...}` plus `[DONE]`;
- Add `x-cache: hit` to the response headers and mark in usage that no upstream cost was incurred.

::: danger Do not cache errors
429s, 5xx, and timeouts can all be transient. Caching an error for 5 minutes turns one blip into one outage.
:::

## 2. Semantic cache

Semantic caching uses embeddings to decide whether "these two questions mean the same thing". It fits high-repetition, low-personalization scenarios such as FAQs and support knowledge bases.

```text
user question -> embedding -> vector search -> similarity >= 0.95? -> return cached answer
                                            └─ no -> call the model -> write to cache
```

Mandatory limits:

- **Isolate by tenant**, or enable it only for public knowledge;
- **Keep the threshold conservative** (start at 0.95) and track the rate of "semantic hit, but the user asked again";
- **Use it only for pure Q&A**, never for tool calls, code execution, or personalized recommendations;
- **Make it switchable in one step**: on trouble, degrade the affected route group to exact caching;
- **Always set a TTL**: knowledge expires, and semantic similarity does not mean the answer is still correct.

::: warning Semantic cache is a cache that can be wrong
An exact cache that is wrong is merely stale; a semantic cache that is wrong answers a different question. If the business is extremely sensitive to correctness, skip it, or use it only where a human can pick up the slack.
:::

## 3. Prompt / KV cache

This layer is not in your gateway's Redis but in the **model provider's inference system**. It caches the KV of a long prefix, so a hit makes input tokens cheaper and the first token faster.

### The prefix must be stable

Whichever vendor you use, the core rule is the same: **starting from the first token, the prefix must be byte-for-byte identical**.

```text
❌ A prefix that changes on every request
[system] Current time 2026-10-30 21:03:17, request_id=req_9f2c...
[docs]   ...... 8k tokens ......
[user]   Summarize this

✅ A stable prefix
[system] You are a documentation assistant. Below is the product manual.
[docs]   ...... 8k tokens ......
[user]   Summarize this (variables go last)
```

Timestamps, request IDs, and randomly ordered few-shot examples all make the cache miss 100% of the time.

### Differences between vendors

| Vendor | Trigger | Prefix requirement | TTL | Metering field (example) |
| --- | --- | --- | --- | --- |
| Anthropic | Explicit `cache_control` breakpoints | Exact match | About 5 minutes by default, configurable longer | `cache_creation_input_tokens` / `cache_read_input_tokens` |
| OpenAI | Automatic once a long prompt crosses a threshold | Exact match | Minutes | `cached_tokens` |
| Gemini | Explicit cached content | Exact match | Configurable | `cachedContentTokenCount` |
| Self-hosted vLLM | Automatic prefix caching | Prefix + replica | Determined by VRAM | Local metrics |

::: tip Defer to the official docs
TTLs, minimum token counts, and discount rates all change. Do not hardcode prices in the gateway; make them configuration and recalibrate regularly.
:::

### What the gateway can do

1. **Stabilize the prefix**: move volatile fields such as time and request IDs to the end or into metadata.
2. **Inject cache breakpoints**: for vendors that support it, insert `cache_control` after system prompts, documents, and few-shot examples.
3. **Record hits**: extract cached tokens from usage and report savings per tenant.
4. **Keep affinity**: route the same prefix to the same vendor and model so it is not shifted away right after being cached.
5. **Protect privacy**: share prefixes across tenants only with great care; prefer per-tenant namespaces.

An anthropic-style breakpoint injection:

```python
def with_cache_control(system_prompt: str, long_docs: str) -> list[dict]:
    return [
        {
            "type": "text",
            "text": system_prompt,
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": long_docs,
            "cache_control": {"type": "ephemeral"},
        },
    ]
```

### Self-hosted inference: KV cache proxying

If you run vLLM / SGLang yourself, the KV cache lives in GPU memory. What the gateway can do is **prefix-aware routing**:

```text
prefix_hash = hash(system + tools + docs)
replica = consistent_hash(prefix_hash, healthy_replicas)
```

Send the same prefix to the same replica so it hits that replica's prefix cache. Scaling up, scaling down, and failover all invalidate the cache; that is a cost you have to accept.

::: warning Never promise "KV cache shared across vendors"
KV layouts, positional encoding, and model weights all differ between vendors, so KV cannot be reused across models. What the gateway can do is "make the same prefix hit the same place repeatedly", not "move KV around".
:::

## 4. Doing the cache math

Assume 100,000 requests per day, 8,000 input tokens on average, 70% of them hitting the prefix cache, and cache reads priced at 10% of normal input:

| Item | Calculation | Result |
| --- | --- | --- |
| Daily input tokens | 100,000 × 8,000 | 800 million |
| Tokens that hit the cache | 800M × 70% | 560 million |
| Tokens that miss the cache | 240 million | 240 million |
| At $3 per million tokens | Cost without cache | $2,400 / day |
| Input cost with cache | 240M × $3/M + 560M × $0.3/M | $888 / day |
| Daily savings | — | About $1,512 |

The numbers are illustrative, but the conclusion holds: **the longer the prefix and the higher the reuse, the bigger the Prompt Cache payoff**. Short system prompts and one-off questions see little benefit.

## Anti-patterns

::: danger The cache key omits the model or version
After switching models you still hit old answers. It looks like "saving money" but is actually "answering wrong". Model alias, prompt version, and route group all belong in the key.
:::

::: danger Sharing personalized answers across tenants
User A's order summary gets served to user B. That is a data incident, not a caching optimization.
:::

::: danger Caching tool call results
Tool results are time-sensitive and have side effects. Unless the tool itself is explicitly idempotent and cacheable, leave it alone.
:::

::: danger No TTL and no size cap
Redis slowly fills up, or the cache never expires. Set a TTL, a maximum number of entries, and a per-entry size limit.
:::

::: danger Turning semantic caching on by default
Semantic caching should be enabled per scenario through an allowlist, not for the whole site. One wrong answer and users stop trusting it.
:::

## Checklist

- [ ] You know which cache layer is currently enabled
- [ ] The cache key includes tenant, model alias, prompt version, and sampling parameters
- [ ] Only successful, complete responses are cached
- [ ] TTLs have jitter and capacity has a limit
- [ ] Singleflight or a distributed lock protects against stampedes
- [ ] Streaming responses cache only complete results and support `x-cache: hit`
- [ ] Semantic cache is tenant-isolated, with a tunable threshold and a kill switch
- [ ] Prompt prefixes are stable and volatile fields come last
- [ ] Cached tokens and the hit rate are recorded
- [ ] The boundary "no KV sharing across vendors" is explicit

Next: [Rate limits and quotas](./rate-limit.md), where we govern "who can use how much".
