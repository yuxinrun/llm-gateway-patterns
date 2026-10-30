---
title: Timeouts, Exceptions, and Error Codes
description: The four-layer timeout model, unified error codes, streaming error handling, and retry decisions.
---

# Timeouts, Exceptions, and Error Codes

The most underrated value of a gateway is not "forwarding succeeded" but **giving actionable information when things fail**. The user sees a 502, operations sees an upstream 429, and the business sees garbled text — these three should never happen at the same time.

## Bigger timeouts are not better

Raising a timeout from 30 seconds to 300 seconds usually just turns "fail fast" into "fail slowly". What you actually need to separate is four kinds of time:

| Timeout | Typical value | What it protects | Symptom when missing |
| --- | --- | --- | --- |
| Connection timeout | 3–5s | DNS, TCP, TLS | Requests hang for a long time when the upstream is unreachable |
| Response header timeout | 10–20s | Whether the upstream has started processing | Queued requests fill up the connection pool |
| First token timeout | 30–60s | Whether the model has started generating | Users stare at a blank screen and connections are not released |
| Idle timeout | 60–120s | A stream stuck mid-way | Half-open connections hold resources for a long time |
| Total budget | 5–15min | Per-request cost ceiling | Abnormally long answers burn money without limit |

::: warning The client timeout must exceed the gateway's total budget
If the client times out at 60 seconds but the gateway allows 10 minutes, the user is long gone while the gateway keeps paying for a request nobody is receiving. Conversely, the gateway timeout should exceed the upstream p99 so normal long-tail requests are not killed by mistake.
:::

## How to measure the first token timeout

`httpx`'s `read` timeout covers the gap "between two reads", not "the first byte". To measure the first token, add an extra wait on the stream iterator:

```python
import asyncio

async def first_chunk_or_timeout(iterator, timeout_s: float):
    try:
        first = await asyncio.wait_for(anext(iterator), timeout=timeout_s)
        return first
    except asyncio.TimeoutError as exc:
        raise GatewayError(504, "first_token_timeout", "Upstream did not produce a token in time.") from exc
```

Once you have the first chunk, hand the remaining iteration back to `relay()`:

```python
async def relay(upstream, first: bytes):
    yield first
    async for chunk in upstream.aiter_bytes():
        yield chunk
```

::: tip The first token and the first byte are not the same thing
Some upstreams return response headers first and then wait several seconds before emitting the first token. Measuring only "headers received" overstates health; what users perceive is the first token.
:::

## Unified error body

Align with the OpenAI error structure so clients need only one parser:

```json
{
  "error": {
    "message": "The request exceeded the model context window.",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "context_length_exceeded",
    "request_id": "req_8f2c1a9b"
  }
}
```

Field conventions:

- `type`: the broad error category, so clients can classify and handle it.
- `code`: a stable machine code, **it must not change with the wording**.
- `param`: the request field that caused the error, `null` if none.
- `request_id`: the troubleshooting anchor shared by the gateway and the upstream.

## Error code table

| code | HTTP | Retryable | Meaning |
| --- | --- | --- | --- |
| `invalid_json` | 400 | No | Request body is not valid JSON |
| `invalid_request` | 400 | No | Missing field or wrong type |
| `context_length_exceeded` | 400 | No | Exceeds the context window |
| `content_filter` | 400 | No | Blocked by a safety policy |
| `invalid_api_key` | 401 | No | Invalid gateway key |
| `insufficient_permissions` | 403 | No | Not allowed to access this model or route |
| `model_not_found` | 404 | No | Model alias or upstream model does not exist |
| `rate_limit_exceeded` | 429 | Yes | Exceeds RPM/TPM |
| `quota_exceeded` | 429 | No | Tenant budget or period quota exhausted |
| `upstream_timeout` | 504 | Yes | Upstream connect or response timeout |
| `upstream_unavailable` | 502 | Yes | Upstream connection failed or returned 5xx |
| `upstream_overloaded` | 503 | Yes | Upstream overloaded; back off |
| `gateway_misconfigured` | 500 | No | Gateway's own configuration is missing |
| `stream_interrupted` | 200 + SSE | Depends | Stream broke after it started |

::: tip Retryable is not "auto-retry"
Retryable only means "another target or a backoff might succeed". Whether to actually retry also depends on request idempotency, remaining budget, and retry budget.
:::

## Funnel everything through one exception class

Do not scatter `return JSONResponse(...)` through your routes. Define one exception and let a single handler produce the output:

```python
from dataclasses import dataclass

@dataclass
class GatewayError(Exception):
    status: int
    code: str
    message: str
    type: str = "gateway_error"
    param: str | None = None
    retryable: bool = False
    retry_after: int | None = None
```

```python
from fastapi import Request
from fastapi.responses import JSONResponse

@app.exception_handler(GatewayError)
async def gateway_error_handler(request: Request, exc: GatewayError):
    request_id = getattr(request.state, "request_id", "req_unknown")
    headers = {"x-request-id": request_id}
    if exc.retry_after is not None:
        headers["retry-after"] = str(exc.retry_after)

    return JSONResponse(
        status_code=exc.status,
        headers=headers,
        content={
            "error": {
                "message": exc.message,
                "type": exc.type,
                "param": exc.param,
                "code": exc.code,
                "request_id": request_id,
            }
        },
    )
```

Set `request.state.request_id` at the request entry point:

```python
@app.middleware("http")
async def attach_request_id(request: Request, call_next):
    request.state.request_id = (
        (request.headers.get("x-request-id") or "").strip()[:128]
        or f"req_{uuid.uuid4().hex[:16]}"
    )
    response = await call_next(request)
    response.headers["x-request-id"] = request.state.request_id
    return response
```

## How to map upstream errors

Every vendor has a different error structure, but the semantics can be aligned:

```python
def map_upstream_error(status: int, payload: dict) -> GatewayError:
    err = payload.get("error") or payload
    message = str(err.get("message") or "Upstream request failed")
    raw_code = str(err.get("code") or err.get("type") or "").lower()

    if status == 429:
        return GatewayError(429, "rate_limit_exceeded", message, "rate_limit_error", retryable=True, retry_after=2)
    if status in (401, 403):
        return GatewayError(502, "upstream_auth_error", "Upstream rejected gateway credentials.", "upstream_error")
    if status == 404 or "model" in raw_code and "not" in raw_code:
        return GatewayError(404, "model_not_found", message, "invalid_request_error", "model")
    if status == 413 or "context_length" in raw_code or "too many tokens" in message.lower():
        return GatewayError(400, "context_length_exceeded", message, "invalid_request_error", "messages")
    if status >= 500:
        return GatewayError(502, "upstream_unavailable", message, "upstream_error", retryable=True)
    return GatewayError(400, "invalid_request", message, "invalid_request_error")
```

A few things to keep in mind:

- **Do not return an upstream 401 to the client as-is**: that makes the client believe its gateway key is wrong. Return 502 and flag an upstream auth problem.
- **Do not echo the raw upstream response body**: it may contain organization IDs, internal request IDs, or even key fragments.
- **On 429, distinguish "upstream rate limited" from "tenant quota"**: the former is retryable, retrying the latter is pointless.

## Streaming errors: the status code is already sent

After the first byte, the only correct expression is an SSE error event:

```text
event: error
data: {"error":{"message":"Upstream stream interrupted.","type":"upstream_error","code":"stream_interrupted","retryable":true,"request_id":"req_..."}}

```

Then close the connection and **do not append a `data: [DONE]`**. Appending it makes the client believe the stream ended normally.

The client's decision order should be:

1. `event: error` received → failure;
2. `[DONE]` received → success;
3. connection closed with neither → failure (interrupted).

## Retries and `Retry-After`

- When an upstream 429 carries `Retry-After`, respect it first and add 0–20% jitter so all replicas do not retry at the same moment.
- When the gateway itself returns 429, include `Retry-After` and quota headers so the client knows how long to wait.
- Separate the "retry budget": at most 2 retries per request, and stop amplifying once the global retry rate exceeds 10%; otherwise one upstream blip becomes a retry storm.

Recommended response headers:

```text
retry-after: 2
x-ratelimit-limit-requests: 600
x-ratelimit-remaining-requests: 0
x-ratelimit-reset-requests: 2s
```

## Idempotency and request ID

Model calls usually have no side effects, but tool calls, billing debits, and audit writes do. The gateway must guarantee that:

- retries of the same `request_id` are not billed twice;
- logs and metrics deduplicate by `request_id`;
- upstream requests carry `x-request-id` to ease reconciliation.

::: danger Do not auto-retry every 5xx
Streaming requests cannot be retried after the first byte; for non-streaming requests that have already incurred upstream cost, a retry doubles the bill. A retry policy has to combine "has it been sent", "can it be rolled back", and "is there budget".
:::

## What to record for troubleshooting

Every failure log should contain at least:

```json
{
  "request_id": "req_...",
  "tenant_id": "acme",
  "route": "chat-default",
  "target": "openai-mini",
  "status": 502,
  "error_code": "upstream_unavailable",
  "upstream_status": 503,
  "attempt": 2,
  "latency_ms": 1830,
  "stream": true,
  "phase": "before_first_byte"
}
```

`phase` matters: `before_first_byte` can retry on another target, `after_first_byte` can only report the error and record the partial output.

## Checklist

- [ ] All five timers are configured: connect, response header, first token, idle, and total budget
- [ ] Client timeout > gateway total budget
- [ ] The unified error body includes a stable `code` and `request_id`
- [ ] Upstream 401/403 are not passed through to the client
- [ ] 429 distinguishes upstream rate limiting from tenant quota
- [ ] Streaming errors are expressed as SSE events, with no extra `[DONE]`
- [ ] Retries are capped, jittered, and respect `Retry-After`
- [ ] Logs record `phase`, `attempt`, and `upstream_status`

Next, we move into the core of production mode: [Routing patterns: weights, tags, and traffic shifting](../02-production/routing.md).
