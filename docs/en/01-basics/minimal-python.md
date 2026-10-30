---
title: Minimal viable gateway (Python)
description: Build a ~130-line LLM gateway with FastAPI + httpx that supports SSE streaming passthrough.
---

# Minimal viable gateway (Python)

This chapter does not aim for completeness. It does four things: **consolidate keys, validate requests, forward upstream, stream back**. Once it works, you can put any OpenAI-compatible model behind a single entry point.

::: tip What you end up with
- A runnable `gateway.py`
- Support for streaming and non-streaming
- Real HTTP status codes (not always 200)
- A request id that spans client and upstream
- A checklist of "what's still missing before production"
:::

## Prerequisites

- Python 3.11+
- An OpenAI-compatible upstream (OpenAI, DeepSeek, Qwen, Moonshot, and so on)
- The upstream `base_url` and API key

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install "fastapi>=0.115" "uvicorn[standard]>=0.30" "httpx>=0.27"
```

## The full code

Create `gateway.py`:

```python
"""gateway.py — a minimal but production-shaped LLM gateway."""

from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

UPSTREAM_BASE_URL = os.getenv("UPSTREAM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
UPSTREAM_API_KEY = os.getenv("UPSTREAM_API_KEY", "")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gpt-4o-mini")

# connect / read / write / pool: don't use a single "total duration" timeout for streaming
TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=5.0)

client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    client = httpx.AsyncClient(timeout=TIMEOUT)
    yield
    await client.aclose()


app = FastAPI(title="minimal-llm-gateway", lifespan=lifespan)


def error_response(status: int, code: str, message: str, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "message": message,
                "type": "gateway_error",
                "code": code,
                "request_id": request_id,
            }
        },
        headers={"x-request-id": request_id},
    )


def sse_error(code: str, message: str, request_id: str) -> bytes:
    payload = {"error": {"code": code, "message": message, "request_id": request_id}}
    return f"event: error\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    request_id = (request.headers.get("x-request-id") or "").strip()[:128]
    request_id = request_id or f"req_{uuid.uuid4().hex[:16]}"
    started = time.perf_counter()

    if not UPSTREAM_API_KEY:
        return error_response(500, "gateway_misconfigured", "UPSTREAM_API_KEY is not set.", request_id)

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return error_response(400, "invalid_json", "Request body must be valid JSON.", request_id)

    if not isinstance(body, dict) or not isinstance(body.get("messages"), list) or not body["messages"]:
        return error_response(400, "invalid_messages", "`messages` must be a non-empty array.", request_id)

    body.setdefault("model", DEFAULT_MODEL)
    stream = body.get("stream") is True

    headers = {
        "authorization": f"Bearer {UPSTREAM_API_KEY}",
        "content-type": "application/json",
        "x-request-id": request_id,
    }

    assert client is not None
    upstream_request = client.build_request(
        "POST",
        f"{UPSTREAM_BASE_URL}/chat/completions",
        json=body,
        headers=headers,
    )

    # Read the response headers first, then decide the status code; this is what makes status codes real
    try:
        upstream = await client.send(upstream_request, stream=stream)
    except httpx.TimeoutException:
        return error_response(504, "upstream_timeout", "Upstream timed out before headers.", request_id)
    except httpx.HTTPError as exc:
        return error_response(502, "upstream_unreachable", f"Upstream request failed: {exc}", request_id)

    if upstream.status_code >= 400:
        raw = await upstream.aread()
        await upstream.aclose()
        try:
            detail = json.loads(raw)
        except json.JSONDecodeError:
            detail = {"error": {"message": raw.decode("utf-8", "replace")[:500]}}
        return JSONResponse(
            status_code=upstream.status_code,
            content=detail,
            headers={"x-request-id": request_id, "x-upstream-status": str(upstream.status_code)},
        )

    if not stream:
        data = await upstream.aread()
        await upstream.aclose()
        return Response(
            content=data,
            media_type=upstream.headers.get("content-type", "application/json"),
            headers={
                "x-request-id": request_id,
                "x-gateway-latency-ms": f"{(time.perf_counter() - started) * 1000:.0f}",
            },
        )

    async def relay() -> AsyncIterator[bytes]:
        try:
            # Use aiter_bytes rather than aiter_raw so httpx handles gzip;
            # otherwise we would send compressed bytes to the client as if they were SSE text.
            async for chunk in upstream.aiter_bytes():
                yield chunk
        except httpx.HTTPError as exc:
            yield sse_error("upstream_stream_error", str(exc), request_id)
        finally:
            await upstream.aclose()

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
            "x-request-id": request_id,
        },
    )
```

## Run it

Using DeepSeek as an example (any OpenAI-compatible service works):

```bash
export UPSTREAM_BASE_URL="https://api.deepseek.com/v1"
export UPSTREAM_API_KEY="sk-your-real-key"
export DEFAULT_MODEL="deepseek-chat"

uvicorn gateway:app --host 127.0.0.1 --port 8000
```

On Windows PowerShell:

```powershell
$env:UPSTREAM_BASE_URL="https://api.deepseek.com/v1"
$env:UPSTREAM_API_KEY="sk-your-real-key"
$env:DEFAULT_MODEL="deepseek-chat"
uvicorn gateway:app --port 8000
```

### Non-streaming request

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Explain what an LLM gateway is in one sentence"}]}'
```

### Streaming request

`-N` turns off curl's own buffering; without it you will think streaming is broken:

```bash
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"Count to 10, one number per line"}]}'
```

You should see chunks like these:

```text
data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"1"},"index":0}]}

data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"\n2"},"index":0}]}

...

data: [DONE]
```

### Point the OpenAI SDK at the gateway

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="local-dev")

resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

Note that `api_key="local-dev"` is only a placeholder: this minimal version does not validate client keys yet, and the real key exists only inside the gateway process.

## Key design decisions

### 1. Why call `send()` before returning a `StreamingResponse`

The most common pattern is to call `client.stream(...)` inside the generator and immediately return 200. The problem: **you do not have the upstream status code yet**. If upstream returns 401, 429 or 500, the client still sees 200 plus a strange stream.

The order here is:

1. `client.send(..., stream=True)` waits only for the response headers;
2. Check `status_code`; on error, return the real status code immediately;
3. Once 200 is confirmed, build the `StreamingResponse`.

The price is that you must manage `upstream.aclose()` manually, but you get diagnosable status codes in return.

### 2. Four timeout types, not just one

| Timeout | Example | Purpose |
| --- | --- | --- |
| connect | 5s | Prevent hangs in DNS / TCP / TLS |
| read | 300s | In streaming, the maximum gap **between two reads** |
| write | 30s | Prevent hangs when upstream receives slowly |
| pool | 5s | Fail fast when the connection pool is exhausted |

Writing `httpx.Timeout(300)` also sets connect to 300 seconds — when upstream is unreachable, users wait five minutes for an error.

::: warning Total duration still needs separate control
`read=300` only limits the gap "between two chunks", not the total duration of a stream. Production also needs an overall budget (say 10 minutes) that actively terminates the stream and records `stream_total_timeout`.
:::

### 3. `aiter_bytes()` instead of `aiter_raw()`

`aiter_raw()` returns the raw bytes on the wire. If the upstream enables gzip, you get compressed data, but you did not forward the `content-encoding` header to the client, so the client fails to parse it.

`aiter_bytes()` decompresses as needed, at a small CPU cost. Unless you are building a byte-level transparent proxy, use the latter.

### 4. The request id spans three places

- The `x-request-id` response header
- The `request_id` in error bodies
- The `x-request-id` forwarded upstream

Many vendors carry this field into their own logs. When something breaks, you can align the gateway logs, the upstream support ticket and the client error.

### 5. Error bodies pass through first, get normalized next

Here, 4xx/5xx from upstream are passed through with an added request id, to preserve the vendor's original error details. The downside is that clients must understand multiple error formats — exactly what the next chapter on [error normalization](./errors-timeout.md) solves.

## What to do about errors during streaming

Once the first byte is written, the HTTP status code cannot change. At that point you can only:

1. Send an SSE error event;
2. Close the connection;
3. Log `stream_error` in the gateway and mark the request as "partially successful".

```text
event: error
data: {"error":{"code":"upstream_stream_error","message":"...","request_id":"req_..."}}
```

Clients must handle three ways a stream can end:

- Receiving `data: [DONE]` normally
- Receiving `event: error`
- The connection simply dropping (no `[DONE]`)

If you only check the first one, production will show "the answer stopped halfway but the UI says success".

## What's still missing before production

| Gap | Risk | Chapter |
| --- | --- | --- |
| No client authentication | Anyone can burn your quota | [Auth and isolation](../02-production/auth-tenant.md) |
| No rate limiting | One user exhausts the upstream quota | [Rate limits and quotas](../02-production/rate-limit.md) |
| No routing or fallback | Upstream failure becomes business failure | [Routing patterns](../02-production/routing.md) |
| No metering | Cost cannot be attributed | [Cost tracking](../02-production/cost.md) |
| No structured logs | Debugging by guesswork | [Observability](../03-observability/logging-tracing.md) |
| No graceful shutdown | Streaming requests get cut off during releases | [Horizontal scaling](../06-deploy/scaling.md) |

## Five common pitfalls

::: danger Using `requests` in async routes
`requests` is synchronous and blocks, stalling the whole event loop. One slow request can make the entire gateway unresponsive. Use `httpx.AsyncClient` or `aiohttp`.
:::

::: danger Copying every upstream response header back
`content-length`, `content-encoding` and `transfer-encoding` may all be inconsistent with the new response body, causing truncation or parse failures on the client. Keep only the headers you need.
:::

::: danger Wrapping SSE in `GZipMiddleware`
Compression middleware buffers data, so streaming degrades into "everything at the end". Exclude SSE routes from compression.
:::

::: danger Forgetting to close the upstream response
Normal completion, client disconnect, exceptions — always call `aclose()`. Otherwise the connection pool slowly drains.
:::

::: danger Using a total timeout to cap long answers
A 300-second "total timeout" kills legitimate long-form generation. Separate connect, first byte, idle and the overall budget.
:::

## Pre-launch checklist

- [ ] Client key validation is wired in (this version has none)
- [ ] RPM / daily budget configured per key
- [ ] Upstream keys live only in a Secret Manager or environment variables
- [ ] Request body size and `max_tokens` have upper bounds
- [ ] First-token timeout and total duration budget are set
- [ ] Streaming errors and client disconnects are logged
- [ ] The gateway itself has replicas and health checks
- [ ] Logs contain no keys and no full prompts

## Next steps

- Want the TypeScript version, plus the parsing details behind "one network packet is not one SSE event": [Minimal TS gateway and SSE forwarding](./minimal-ts-sse.md)
- Want clients to always see a single error format: [Timeouts, exceptions and error codes](./errors-timeout.md)
- Want to jump to multi-model switching: [Routing patterns](../02-production/routing.md)
