---
title: Long Context and Performance Limits
description: A 128k window does not mean 128k of effective context. Understand token cost, time to first token, and attention dilution so you can choose the right length strategy.
---

# Long Context and Performance Limits

A model claiming 128k doesn't mean you should fill 128k. In practice, **long context pushes three things up at once: cost, time to first token, and error rate**. Many teams trip over the intuition "the window is big, so put everything in".

## Key takeaways

- **The window limit is a hard constraint; effective context is a soft one.** Information in the middle is the easiest to miss.
- **Input tokens increase cost linearly, and TTFT grows roughly linearly too.** A 128k input can have a TTFT more than ten times that of 8k.
- **Length routing must happen before forwarding**, using estimation plus a safety margin, not by waiting for an upstream 400.
- **Compression beats truncation.** Truncation silently loses information; summaries and retrieval keep the essentials.
- **Long-context requests need their own rate limit**, or a single request can consume a tenant's entire TPM.
- **Long context and prefix cache are good friends**: put the fixed long document first and you cut cost significantly.

## A window is not effective context

Academia tests long-context recall with "needle in a haystack", and the results are quite consistent:

- Recall is best when the information is at the **beginning or the end**.
- Recall drops noticeably when the information is in the **middle**, the well-known lost in the middle effect.
- As length grows, **reasoning quality degrades** even when the information is recalled.
- Multi-hop questions (which require combining several pieces of information) are much harder than single-point lookup.

So the right question isn't "does it fit", but "once it fits, can the model still use it well".

| Context length | Typical behavior | Recommendation |
| --- | --- | --- |
| < 8k | Stable | Normal use |
| 8k-32k | Usable for most tasks | Watch out for middle information |
| 32k-128k | Single-point retrieval still works, reasoning degrades | Compress first, put key information up front |
| > 128k | Both cost and latency are high | Only for essential cases, and evaluate first |

## The four costs of long context

### 1. Token cost

Input tokens are billed by volume, so cost grows linearly. Assume $3/M for input:

| Input length | Cost per call | 100k calls per day |
| ---: | ---: | ---: |
| 4k | $0.012 | $1,200 |
| 32k | $0.096 | $9,600 |
| 128k | $0.384 | $38,400 |

If you stuff the whole document in every time, cost grows linearly with document length, even though most requests only use a small part of it.

### 2. Time to first token

Prefill has to process every input token, so TTFT grows with length. The numbers vary widely by hardware and model, but the trend is consistent: **double the input and TTFT roughly doubles** (more pronounced when bandwidth-bound).

For interactive products, users start to suspect a stall once TTFT passes 3 seconds. A 100k-input request reaching 10 seconds of TTFT is not rare.

### 3. KV cache memory

With self-hosted inference, KV cache usage is proportional to sequence length x layers x hidden dimension. Long context sharply reduces concurrency:

```text
Fixed GPU memory → larger KV per request → fewer concurrent requests
```

This is also why long-context requests need their own rate limit: they don't take "one request slot", they take "the GPU memory of several normal requests".

### 4. Attention dilution

The longer the context, the more attention the model spreads across irrelevant content. Symptoms:

- Instruction following degrades (format requirements in system get ignored).
- Factuality drops (similar but wrong content gets mixed in).
- Output becomes verbose (it tries to cover everything).

## Get the token count right first

Every length decision depends on an accurate token count. Three sources:

| Source | Accuracy | Cost |
| --- | --- | --- |
| Vendor tokenizer | High | You must load the matching tokenizer |
| Generic estimate (characters/4) | Large error on mixed Chinese and English | Zero |
| `usage` returned by the upstream | Accurate, but after the fact | Can't be used for pre-flight gating |

The gateway needs **upfront estimation**, calibrated afterward with real usage. Maintain a per-model factor table:

```python
def estimate_tokens(text: str, model: str) -> int:
    # Chinese: about 1 character ≈ 1 token; English: about 4 characters ≈ 1 token
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other = len(text) - cjk
    base = cjk + other / 4
    factor = MODEL_FACTORS.get(model, 1.05)   # keep a 5% margin
    return int(base * factor)
```

Multimodal content needs separate handling: images convert by resolution (formulas differ by vendor), audio by seconds. Tool schemas count too; the JSON for dozens of tools can run to several thousand tokens.

::: warning Estimates are for gating only
Estimation error can reach 20%. Leave plenty of margin when using it to decide "is this over the limit"; **always bill from the usage returned by the upstream**.
:::

## Length routing

Pick a target by estimated length instead of sending every request to the model with the largest window:

```yaml
targets:
  - name: small-ctx
    model: gpt-4o-mini
    context_window: 128000
    max_input_tokens: 32000
    cost_tier: low

  - name: large-ctx
    model: claude-sonnet
    context_window: 200000
    max_input_tokens: 180000
    cost_tier: high
```

```python
def pick_by_length(candidates, input_tokens: int, max_output: int):
    need = input_tokens + max_output
    fits = [t for t in candidates if need <= t.context_window]
    if not fits:
        raise GatewayError(413, "context_too_large", f"need {need} tokens")
    return min(fits, key=lambda t: (t.cost_tier, t.context_window))
```

Note that `need` must include `max_tokens`: choosing a target by input alone still lets the output stage overflow.

### Reserve room for output

Many 400s come from "the input sits exactly at the limit":

```python
def validate_length(body: dict, target) -> None:
    input_tokens = estimate_input(body)
    max_output = body.get("max_tokens") or target.default_max_output
    if input_tokens + max_output > target.context_window:
        suggested = target.context_window - input_tokens
        raise GatewayError(
            413,
            "context_too_large",
            f"input {input_tokens} + output {max_output} exceeds {target.context_window}; "
            f"reduce input or set max_tokens <= {max(0, suggested)}",
        )
```

An actionable suggestion in the error message is far more useful than a bare "context length exceeded".

## Compression strategies

| Strategy | What it preserves | Cost | When to use |
| --- | --- | --- | --- |
| Head truncation | The beginning | Low | system + latest question |
| Sliding window | The most recent N turns | Low | Chat |
| Summary compression | Global key points | Medium (requires a model call) | Long conversations, meeting notes |
| Retrieval augmentation | Relevant snippets | Medium | Knowledge base Q&A |
| Structured extraction | Key fields | Low | Tables, logs, JSON |
| External reference | Reference ID | Low | Tool results, documents |

### Sliding window + summary

The most common combination in chat: keep the last N turns verbatim and compress earlier content into a summary.

```python
def build_context(history: list[dict], summary: str | None, max_tokens: int) -> list[dict]:
    messages = []
    if summary:
        messages.append({"role": "system", "content": f"Summary of earlier conversation: {summary}"})

    kept = []
    used = 0
    for m in reversed(history):
        cost = estimate_tokens(m["content"], "default")
        if used + cost > max_tokens:
            break
        kept.append(m)
        used += cost
    messages.extend(reversed(kept))
    return messages
```

The summary itself needs a length limit, or you end up with "a summary longer than the original".

### Retrieval beats full inclusion

If the task is "find the answer in a document", retrieving 5 relevant snippets usually works better and costs less than stuffing in the whole document. Long context isn't a replacement for RAG; **it just pushes the retrieval step inside the model**, and the model's retrieval behavior is far less controllable than a dedicated retrieval system.

## Long context and caching

Long documents are ideal prefix cache material: fixed content, many tokens, high reuse.

```text
[cached prefix] Full document / codebase / manual
[changing part] User question
```

The prerequisites:

- Document order is stable (don't re-sort paragraphs each time).
- Document content has no timestamps or random IDs inserted.
- Requests from the same tenant route to the same upstream (provider caches are organization-scoped; self-hosted caches are instance-scoped).

For a 100k document, cache read pricing is usually 1/10 of regular input, and TTFT drops noticeably. This is the highest-value optimization in long-context scenarios.

## Long context and timeouts

Prefill for long inputs can exceed the default timeout. Scale it with length:

```python
def timeout_for(input_tokens: int, stream: bool) -> httpx.Timeout:
    base = 30 + input_tokens / 1000 * 0.8   # rough: 0.8 seconds per 1k tokens
    first_byte = min(base, 180)
    return httpx.Timeout(
        connect=10.0,
        read=600.0 if stream else first_byte + 60,
        write=30.0,
        pool=10.0,
    )
```

For non-streaming requests, long input plus long output easily exceeds 60 seconds. **Force streaming for long context**: it improves the experience and avoids proxy-layer timeouts.

## Long context and rate limiting

| Dimension | Suggestion |
| --- | --- |
| Per-request input cap | Set by plan, for example Free 32k, Pro 128k |
| Per-request TPM accounting | Count a 100k request as 100k against TPM |
| Concurrency | A separate semaphore for long requests so they don't crowd out normal ones |
| Timeout | Tiered by length |
| Cost estimation | Estimate and reserve budget before forwarding |

Without a per-request cap, one user uploading a 500-page PDF can burn the day's budget.

## How to evaluate

Don't judge "does long context work" by feel. Run a small evaluation:

1. **Needle test**: place one fact at different positions in the document and ask the model. Record accuracy at the beginning, middle, and end.
2. **Multi-hop test**: questions that require combining two pieces of information to answer.
3. **Distractor test**: insert similar but wrong information and see whether the model is misled.
4. **Format adherence**: does the model still follow output format requirements with long context?
5. **Cost and latency**: record TTFT, total duration, and token counts.

The eval set doesn't need to be large; a few dozen items reveal the trend. The key is to **use your own data**; public leaderboards often differ a lot from your scenario.

## Anti-patterns

| Anti-pattern | Consequence |
| --- | --- |
| Stuffing in as much as possible | Cost, latency, and accuracy all lose |
| Choosing a model by input length alone | The output stage can still overflow |
| Using upstream 400s as length validation | You fail only after paying |
| Truncating without any marker | The model sees incomplete content and doesn't know |
| No rate limit for long requests | One request consumes the tenant's quota |
| Re-sorting a long document every time | Prefix cache fully invalidated |
| Using long context instead of retrieval | Expensive and uncontrollable |
| Shipping without evaluation | You don't know whether quality improved or regressed |

## Checklist

- [ ] You distinguish "window limit" from "effective context"
- [ ] Token estimates cover text, images, and tool schemas, with a safety margin
- [ ] `input + max_tokens` is validated before forwarding, with 413 on overflow
- [ ] Routing is tiered by length, and long requests go to large-window models
- [ ] You have compression strategies such as sliding windows, summaries, or retrieval
- [ ] Long documents use prefix caching with a stable order
- [ ] Timeouts scale with input length, and long requests prefer streaming
- [ ] Per-request input and concurrency caps are configured by plan
- [ ] You have run needle and multi-hop evaluations on your own data
- [ ] TTFT, cost, and error rate for long requests are monitored separately

## Next

Now that you know the limits of a single request, look at overall capacity: [Load Testing and Bottleneck Analysis](./load-testing.md).
