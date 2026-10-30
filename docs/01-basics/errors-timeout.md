---
title: 超时、异常与错误码
description: 四层超时模型、统一错误码、流式错误处理与可重试判定。
---

# 超时、异常与错误码

网关最容易被低估的价值，不是「转发成功」，而是**失败时给出可行动的信息**。用户看到 502，运维看到上游 429，业务看到一段乱码——这三件事不该同时发生。

## 超时不是越大越好

把超时从 30 秒调到 300 秒，通常只是把「快速失败」变成「慢慢失败」。真正要区分的是四类时间：

| 超时 | 典型值 | 保护什么 | 缺失后的症状 |
| --- | --- | --- | --- |
| 连接超时 | 3～5s | DNS、TCP、TLS | 上游不可达时长时间挂起 |
| 响应头超时 | 10～20s | 上游是否开始处理 | 排队中的请求占满连接池 |
| 首 Token 超时 | 30～60s | 模型是否开始生成 | 用户盯着空屏，连接不释放 |
| 空闲超时 | 60～120s | 流中途卡死 | 半开连接长期占用资源 |
| 总预算 | 5～15min | 单请求成本上限 | 异常长回答无限烧钱 |

::: warning 客户端超时要大于网关总预算
如果客户端 60 秒超时，网关却允许 10 分钟，用户早就走了，网关还在为一次「无人接收」的请求付费。反过来，网关超时应大于上游的 p99，避免正常长尾被误杀。
:::

## 首 Token 超时怎么测

`httpx` 的 `read` 超时管的是「两次读取之间」，不是「首字节」。要测首 Token，需要在流迭代器上做一次额外等待：

```python
import asyncio

async def first_chunk_or_timeout(iterator, timeout_s: float):
    try:
        first = await asyncio.wait_for(anext(iterator), timeout=timeout_s)
        return first
    except asyncio.TimeoutError as exc:
        raise GatewayError(504, "first_token_timeout", "Upstream did not produce a token in time.") from exc
```

拿到首块后，再把剩余迭代交还给 `relay()`：

```python
async def relay(upstream, first: bytes):
    yield first
    async for chunk in upstream.aiter_bytes():
        yield chunk
```

::: tip 首 Token 与首字节不是一回事
有些上游会先返回响应头，再等几秒才吐第一个 token。只测「拿到响应头」会高估健康度，用户感知的是首 Token。
:::

## 统一错误体

对齐 OpenAI 的错误结构，客户端只需要一套解析：

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

字段约定：

- `type`：错误大类，便于客户端分类处理。
- `code`：稳定机器码，**不要随文案变化**。
- `param`：出错的请求字段，没有则为 `null`。
- `request_id`：贯穿网关与上游的排障锚点。

## 错误码表

| code | HTTP | 可重试 | 含义 |
| --- | --- | --- | --- |
| `invalid_json` | 400 | 否 | 请求体不是合法 JSON |
| `invalid_request` | 400 | 否 | 字段缺失或类型错误 |
| `context_length_exceeded` | 400 | 否 | 超出上下文窗口 |
| `content_filter` | 400 | 否 | 被安全策略拦截 |
| `invalid_api_key` | 401 | 否 | 网关密钥无效 |
| `insufficient_permissions` | 403 | 否 | 无权访问该模型/路由 |
| `model_not_found` | 404 | 否 | 模型别名或上游模型不存在 |
| `rate_limit_exceeded` | 429 | 是 | 超过 RPM/TPM |
| `quota_exceeded` | 429 | 否 | 租户预算或周期配额用尽 |
| `upstream_timeout` | 504 | 是 | 上游连接/响应超时 |
| `upstream_unavailable` | 502 | 是 | 上游连接失败或 5xx |
| `upstream_overloaded` | 503 | 是 | 上游过载，建议退避 |
| `gateway_misconfigured` | 500 | 否 | 网关自身配置缺失 |
| `stream_interrupted` | 200 + SSE | 视情况 | 流开始后中断 |

::: tip 可重试不是「自动重试」
可重试只表示「换个目标或退避后可能成功」。是否重试还要看请求幂等性、剩余预算和重试预算。
:::

## 用异常类收口

不要在路由里到处 `return JSONResponse(...)`。定义一个异常，让统一处理器负责输出：

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

请求入口设置 `request.state.request_id`：

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

## 上游错误怎么映射

不同厂商的错误结构不同，但语义可以对齐：

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

几点注意：

- **不要把上游 401 原样返回给客户端**：那会让客户端以为自己的网关密钥错了。应返回 502，并标记上游鉴权问题。
- **不要把上游原始响应体整段回显**：可能包含组织 ID、内部请求 ID，甚至密钥片段。
- **429 要区分「上游限流」和「租户配额」**：前者可重试，后者重试也没用。

## 流式错误：状态码已经发出去了

首字节之后，唯一正确的表达是 SSE 错误事件：

```text
event: error
data: {"error":{"message":"Upstream stream interrupted.","type":"upstream_error","code":"stream_interrupted","retryable":true,"request_id":"req_..."}}

```

然后关闭连接，**不要补一个 `data: [DONE]`**。补了会让客户端误以为正常结束。

客户端判定顺序应是：

1. 收到 `event: error` → 失败；
2. 收到 `[DONE]` → 成功；
3. 连接结束但两者都没有 → 失败（中断）。

## 重试与 `Retry-After`

- 上游 429 带 `Retry-After` 时，优先尊重它，并加 0～20% 抖动，避免所有副本同时重试。
- 网关返回 429 时也带上 `Retry-After` 和配额响应头，客户端才知道该等多久。
- 区分「重试预算」：单请求最多 2 次、全局重试率超过 10% 时停止放大，否则一次上游抖动会变成重试风暴。

推荐响应头：

```text
retry-after: 2
x-ratelimit-limit-requests: 600
x-ratelimit-remaining-requests: 0
x-ratelimit-reset-requests: 2s
```

## 幂等性与 request id

模型调用通常没有副作用，但工具调用、计费扣减、审计写入有。网关要保证：

- 同一 `request_id` 的重试不会重复计费；
- 日志与指标以 `request_id` 去重；
- 上游请求携带 `x-request-id`，方便对账。

::: danger 不要自动重试所有 5xx
流式请求在首字节后不能重试；非流式请求如果已经产生上游费用，重试会双倍计费。重试策略要结合「是否已发送」「是否可回滚」「是否有预算」。
:::

## 排障时要记录什么

每一条失败日志至少包含：

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

`phase` 很关键：`before_first_byte` 可以换目标重试，`after_first_byte` 只能报错并记录部分输出。

## 检查清单

- [ ] 连接、响应头、首 Token、空闲、总预算五类时间都有配置
- [ ] 客户端超时 > 网关总预算
- [ ] 统一错误体包含稳定 `code` 与 `request_id`
- [ ] 上游 401/403 不直接透传给客户端
- [ ] 429 区分上游限流与租户配额
- [ ] 流式错误用 SSE 事件表达，不补 `[DONE]`
- [ ] 重试有上限、有抖动、尊重 `Retry-After`
- [ ] 日志记录 `phase`、`attempt`、`upstream_status`

下一篇进入生产模式的核心：[路由模式：权重、标签与切流](../02-production/routing.md)。
