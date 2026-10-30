---
title: 最小可用网关（Python）
description: 用 FastAPI + httpx 写一个约 130 行、支持 SSE 流式转发的 LLM 网关。
---

# 最小可用网关（Python）

这一篇不追求功能齐全，只做四件事：**收口密钥、校验请求、转发上游、流式回传**。做完你就能把任意 OpenAI 兼容模型接到一个统一入口上。

::: tip 你将得到
- 一个可运行的 `gateway.py`
- 支持流式与非流式
- 真实的 HTTP 状态码（不是永远 200）
- 贯穿上下游的 request id
- 一份「离生产还差什么」的清单
:::

## 前置条件

- Python 3.11+
- 一个 OpenAI 兼容的上游（OpenAI、DeepSeek、通义千问、Moonshot 等均可）
- 上游的 `base_url` 与 API Key

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install "fastapi>=0.115" "uvicorn[standard]>=0.30" "httpx>=0.27"
```

## 完整代码

新建 `gateway.py`：

```python
"""gateway.py — 一个最小但接近生产形态的 LLM 网关。"""

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

# connect / read / write / pool：流式场景不要用「总时长」一刀切
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

    # 先拿到响应头，再决定返回什么状态码；这一步是「真实状态码」的关键
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
            # 用 aiter_bytes 而不是 aiter_raw：让 httpx 处理 gzip，
            # 否则我们会把压缩字节当成 SSE 明文发给客户端。
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

## 跑起来

以 DeepSeek 为例（你也可以换成任意 OpenAI 兼容服务）：

```bash
export UPSTREAM_BASE_URL="https://api.deepseek.com/v1"
export UPSTREAM_API_KEY="sk-你的真实密钥"
export DEFAULT_MODEL="deepseek-chat"

uvicorn gateway:app --host 127.0.0.1 --port 8000
```

Windows PowerShell：

```powershell
$env:UPSTREAM_BASE_URL="https://api.deepseek.com/v1"
$env:UPSTREAM_API_KEY="sk-你的真实密钥"
$env:DEFAULT_MODEL="deepseek-chat"
uvicorn gateway:app --port 8000
```

### 非流式请求

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"用一句话解释什么是 LLM 网关"}]}'
```

### 流式请求

`-N` 关闭 curl 自身缓冲，否则你会以为流式坏了：

```bash
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"数到 10，每个数字一行"}]}'
```

你会看到类似这样的分片：

```text
data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"1"},"index":0}]}

data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"\n2"},"index":0}]}

...

data: [DONE]
```

### 用 OpenAI SDK 指向网关

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="local-dev")

resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

注意 `api_key="local-dev"` 只是占位：这个最小版本还没有校验客户端密钥，真实密钥只存在于网关进程里。

## 关键设计拆解

### 1. 为什么先 `send()` 再返回 `StreamingResponse`

最常见的写法是直接在生成器里 `client.stream(...)`，然后马上返回 200。问题是：**此时你还没拿到上游状态码**。上游 401、429、500，客户端看到的都是 200 + 一段奇怪的流。

这里的顺序是：

1. `client.send(..., stream=True)` 只等到响应头；
2. 检查 `status_code`，错误就直接返回真实状态码；
3. 确认 200 后，再构造 `StreamingResponse`。

代价是必须手动管理 `upstream.aclose()`，但换来的是可诊断的状态码。

### 2. 四类超时，不要只设一个

| 超时 | 示例值 | 作用 |
| --- | --- | --- |
| connect | 5s | 防止 DNS / TCP / TLS 卡死 |
| read | 300s | 流式场景下是**两次读取之间**的最大间隔 |
| write | 30s | 防止上游接收缓慢导致挂起 |
| pool | 5s | 连接池耗尽时快速失败 |

`httpx.Timeout(300)` 这种写法会把 connect 也设成 300 秒——上游不可达时，用户要等五分钟才收到错误。

::: warning 总时长仍需单独控制
`read=300` 只限制「两次数据之间」的间隔，不限制整条流的总时长。生产环境还需要一个总预算（例如 10 分钟），到点主动终止并记录 `stream_total_timeout`。
:::

### 3. `aiter_bytes()` 而不是 `aiter_raw()`

`aiter_raw()` 返回网络上的原始字节。如果上游启用了 gzip，你拿到的是压缩数据，但又没有把 `content-encoding` 头转发给客户端，客户端会解析失败。

`aiter_bytes()` 会按需解压，代价是少量 CPU。除非你要做字节级透明代理，否则用后者。

### 4. request id 贯穿三处

- 响应头 `x-request-id`
- 错误体里的 `request_id`
- 转发给上游的 `x-request-id`

很多厂商会把该字段带进他们的日志。出问题时，你可以同时拿网关日志、上游工单和客户端报错对齐。

### 5. 错误体先「透传」，下一步再「归一」

这里对上游 4xx/5xx 采取透传 + 补充 request id 的策略，目的是保留厂商的原始错误信息。缺点是客户端要认识多套错误格式——这正是下一篇[错误码标准化](./errors-timeout.md)要解决的。

## 流式过程中的错误怎么办

一旦第一个字节写出去，HTTP 状态码就不能改了。此时只能：

1. 发送一条 SSE 错误事件；
2. 关闭连接；
3. 在网关日志里记录 `stream_error`，并标记该请求为「部分成功」。

```text
event: error
data: {"error":{"code":"upstream_stream_error","message":"...","request_id":"req_..."}}
```

客户端必须同时处理三种结束方式：

- 正常收到 `data: [DONE]`
- 收到 `event: error`
- 连接直接断开（没有 `[DONE]`）

只判断第一种，线上就会出现「回答到一半停住但 UI 显示成功」的问题。

## 离生产还差什么

| 缺口 | 风险 | 对应章节 |
| --- | --- | --- |
| 没有客户端鉴权 | 任何人都能白嫖你的额度 | [鉴权隔离](../02-production/auth-tenant.md) |
| 没有限流 | 一个用户打满上游配额 | [限流与配额](../02-production/rate-limit.md) |
| 没有路由与兜底 | 上游故障即业务故障 | [路由模式](../02-production/routing.md) |
| 没有计量 | 成本无法归因 | [成本统计](../02-production/cost.md) |
| 没有结构化日志 | 排障靠猜 | [可观测](../03-observability/logging-tracing.md) |
| 没有优雅停机 | 发布时流式请求被截断 | [水平扩展](../06-deploy/scaling.md) |

## 五个常见坑

::: danger 在 async 路由里用 `requests`
`requests` 是同步阻塞的，会卡住整个事件循环。一个慢请求能让整个网关失去响应。用 `httpx.AsyncClient` 或 `aiohttp`。
:::

::: danger 把上游响应头全部复制回来
`content-length`、`content-encoding`、`transfer-encoding` 都可能与新响应体不一致，导致客户端截断或解析失败。只保留必要头。
:::

::: danger 用 `GZipMiddleware` 包住 SSE
压缩中间件会缓冲数据，流式直接变成「最后一次性返回」。SSE 路由要排除在压缩之外。
:::

::: danger 忘记关闭上游响应
流正常结束、客户端断开、异常退出，都要 `aclose()`。否则连接池会被慢慢耗光。
:::

::: danger 用总超时限制长回答
一个 300 秒的「总超时」会杀掉正常的长文本生成。区分连接、首字节、空闲和总预算。
:::

## 上线前检查清单

- [ ] 客户端密钥校验已接入（当前版本没有）
- [ ] 每密钥 RPM / 日预算已配置
- [ ] 上游密钥只存在于 Secret Manager 或环境变量
- [ ] 请求体大小与 `max_tokens` 有上限
- [ ] 首 Token 超时与总时长预算已设置
- [ ] 流式错误、客户端断开都有日志
- [ ] 网关自身有多副本与健康检查
- [ ] 日志中不出现密钥与完整 prompt

## 下一步

- 想要 TypeScript 版本、以及「一个网络包不等于一个 SSE 事件」的解析细节：[TS 最小网关与 SSE 转发](./minimal-ts-sse.md)
- 想让客户端永远只看到一种错误格式：[超时、异常与错误码](./errors-timeout.md)
- 想直接看多模型怎么切：[路由模式](../02-production/routing.md)
