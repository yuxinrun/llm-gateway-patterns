---
title: 压测与瓶颈定位
description: 面向流式模型调用的压测方法：mock 上游、阶梯加压、拐点识别与常见瓶颈清单。
---

# 压测与瓶颈定位

「压测跑到 500 QPS 没问题，上线 50 QPS 就崩了」——这类事故通常不是压测工具的问题，而是压测**测错了对象**：要么上游是 mock 且零延迟，要么只测了短请求，要么没测流式长连接。

LLM 网关的压测和普通 CRUD API 有本质差异，照搬传统方案会得到一组漂亮的、没有意义的数字。

## 先说结论

- **分三层压**：网关自身、端到端（含真实上游配额）、故障场景。
- **必须压流式**。流式请求占用连接的时间是普通请求的几十倍。
- **mock 上游用于测网关容量，真实上游用于测配额与端到端体验**，两者不能混。
- **找拐点，不要找最大值**。拐点之后每增加一点负载，延迟和错误率都会陡增。
- **关注连接数、文件描述符、内存和事件循环延迟**，它们比 QPS 更早暴露问题。
- **压测环境要与生产同构**：副本数、代理、超时、限流配置都要一致。

## 压测的三层目标

| 层 | 上游 | 回答的问题 | 风险 |
| --- | --- | --- | --- |
| 网关容量 | mock，可控延迟 | 单副本能扛多少并发？ | 忽略真实上游波动 |
| 端到端 | 真实上游 | 用户实际体验如何？ | 受配额限制，成本高 |
| 故障场景 | mock + 故障注入 | 降级、熔断、重试是否有效？ | 配置可能与生产不同 |

大多数团队只做第二层，结果既压不上去（上游 429），也不知道网关本身的极限。正确顺序是：先用 mock 把网关压到拐点，再用真实上游验证端到端，最后做故障注入。

## 与普通 API 压测的差异

| 差异 | 影响 |
| --- | --- |
| 流式长连接 | 连接占用时间是普通请求的 10–100 倍 |
| 响应大小不定 | 同样 QPS 下带宽差异巨大 |
| 上游有配额 | 压测可能直接把生产配额打满 |
| 非确定性 | 同样的请求耗时不同，方差大 |
| token 计费 | 压测本身就在花钱 |
| 连接池敏感 | 池太小会排队，池太大打爆上游 |

最后一条尤其容易被忽略：很多「网关慢」的问题，根因是 `httpx` 连接池默认上限太小，请求在池里排队，而不是上游慢。

## 压测类型

| 类型 | 目的 | 时长 | 判定 |
| --- | --- | --- | --- |
| 基准测试 | 单请求延迟基线 | 分钟级 | P50/P95/P99 |
| 阶梯加压 | 找拐点 | 30–60 分钟 | 延迟拐点、错误率拐点 |
| 稳定性测试 | 内存泄漏、连接泄漏 | 2–24 小时 | 内存曲线、FD 数量 |
| 尖峰测试 | 突发流量 | 分钟级 | 限流是否生效、是否雪崩 |
| 故障注入 | 降级链路 | 分钟级 | 熔断、切换、恢复 |

### 阶梯加压怎么设计

```text
阶段 1: 10 并发  × 5 分钟
阶段 2: 50 并发  × 5 分钟
阶段 3: 100 并发 × 5 分钟
阶段 4: 200 并发 × 5 分钟
阶段 5: 400 并发 × 5 分钟
```

每个阶段之间留 1–2 分钟观察恢复情况。判定拐点的信号：

- P95 延迟超过基线的 2 倍。
- 错误率超过 1%。
- 事件循环延迟（event loop lag）持续上升。
- 连接池等待时间上升。
- CPU 到 80% 但吞吐不再增长。

**拐点就是你的安全容量**，实际部署按拐点的 60–70% 设定告警和扩容阈值。

## Mock 上游

mock 要模拟真实上游的关键特征，而不是只返回 200：

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

这个 mock 能模拟三件关键的事：首字延迟、生成速度、流式连接占用时长。如果你的网关在 mock 下都扛不住，问题一定在网关自身。

再加一个故障开关：

```python
FAIL_RATE = 0.0   # 通过环境变量注入

@app.middleware("http")
async def inject_failure(request, call_next):
    if random.random() < FAIL_RATE:
        return JSONResponse({"error": {"message": "mock 503"}}, status_code=503)
    return await call_next(request)
```

## k6 压流式

k6 原生支持 SSE，但需要手动解析：

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
    messages: [{ role: 'user', content: '写一段 200 字的说明' }],
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

  // k6 的 http.post 会等完整响应，严格来说不适合测流式。
  // 需要真正的流式客户端时，使用 k6 的 experimental websockets/grpc 或自定义 xk6 扩展。
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
```

::: warning k6 的流式限制
k6 的 `http` 模块会缓冲完整响应，`ttft_ms` 无法准确测量。要压真实流式，选择：

- 用 `xk6` 自定义扩展或 Go 写客户端。
- 用 Locust 的 `gevent` + `requests` 流式接口。
- 用 Python `asyncio` + `httpx` 自己写压测器（最灵活）。

不要用「普通 HTTP 压测工具的 QPS」来推断流式容量，两者差一个数量级。
:::

### Python 流式压测器

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
            "messages": [{"role": "user", "content": "写一段 200 字的说明"}],
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

压测器本身的连接池要足够大，否则你测的是压测器的瓶颈。

## 瓶颈清单

按出现频率排序：

| 瓶颈 | 表现 | 检查 |
| --- | --- | --- |
| 上游连接池太小 | 延迟高但 CPU 低 | `pool` 等待、`max_connections` |
| 事件循环被阻塞 | 所有请求一起变慢 | event loop lag、同步 IO |
| Redis 往返过多 | 每个请求多次 RTT | 合并检查、pipeline |
| 同步日志 | 高峰期 CPU 飙高 | 日志是否阻塞写 |
| JSON 序列化 | 大响应 CPU 高 | `orjson` 替代 `json` |
| TLS 握手 | 新建连接慢 | 连接复用、会话复用 |
| DNS | 间歇性超时 | 缓存、`getaddrinfo` 耗时 |
| 文件描述符 | `Too many open files` | `ulimit -n` |
| 内存 | GC 停顿、OOM | RSS 曲线、对象分配 |
| Gzip | CPU 高、TTFT 差 | 流式场景通常不建议压缩 |

### 事件循环阻塞

Python 异步服务最常见的隐形杀手。任何同步调用都会卡住整个循环：

```python
# ❌ 阻塞事件循环
requests.get(url)
time.sleep(1)
open("big.json").read()

# ✅
await client.get(url)
await asyncio.sleep(1)
await asyncio.to_thread(read_file, "big.json")
```

用内置的 debug 模式可以在开发环境发现慢回调：

```bash
PYTHONASYNCIODEBUG=1 uvicorn gateway:app
```

生产环境可以监控 event loop lag（比如每秒调度一次，测量实际延迟）。

## 容量估算

用 Little's Law 做粗算：

```text
并发请求数 = 到达速率 × 平均停留时间
```

流式请求的平均停留时间可能是 10–30 秒。如果要支撑 10 QPS 的流式请求，平均停留 15 秒，那么稳态并发就是 150。这 150 个并发会同时占用：

- 150 个客户端连接。
- 150 个上游连接。
- 150 份响应缓冲。
- 上游的 150 个并发配额。

很多团队只按 QPS 规划容量，忽略了这个乘法。

## 压测时的注意事项

- **不要压生产**。即使有隔离，也可能影响真实用户和上游配额。
- **用独立的上游 Key**，避免压测流量触发生产限流。
- **压测流量打标签**（`X-Feature: loadtest`），便于从账单和监控中剔除。
- **先小后大**，每次只改一个变量。
- **记录配置快照**：副本数、超时、连接池、限流参数，否则结果无法复现。
- **观察上游**：供应商可能因为你压测而限流，影响其他业务。

## 结果怎么读

| 现象 | 可能原因 |
| --- | --- |
| QPS 上升，P95 平稳 | 还有余量 |
| QPS 上升，P95 线性上升 | 接近容量，开始排队 |
| QPS 不变，P95 陡增 | 已到拐点 |
| 错误率突然上升 | 上游 429 或本地资源耗尽 |
| 延迟高但 CPU 低 | IO 等待、连接池、锁 |
| 内存持续上涨 | 泄漏、缓冲未释放、连接未关闭 |
| 压测结束延迟不恢复 | 连接泄漏或上游仍在处理 |

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 只用短请求压测 | 高估容量数倍 |
| mock 零延迟 | 测不出排队 |
| 只压 QPS 不看并发 | 流式场景严重误判 |
| 压测器连接池太小 | 测的是压测器 |
| 压生产 | 影响真实用户与配额 |
| 不记录配置 | 结果无法复现 |
| 只压不改 | 找不到瓶颈 |
| 忽略上游配额 | 压测变成故障演练 |

## Checklist

- [ ] 明确压测目标：网关容量 / 端到端 / 故障场景
- [ ] mock 上游包含 TTFT、生成速度、流式时长
- [ ] 压测覆盖流式与长上下文请求
- [ ] 使用真实并发模型，而非只报 QPS
- [ ] 监控 event loop lag、连接池等待、FD、内存
- [ ] 阶梯加压找到拐点，按 60–70% 设定容量
- [ ] 压测流量打标，使用独立上游 Key
- [ ] 记录压测时的完整配置快照
- [ ] 做了 2 小时以上的稳定性测试
- [ ] 故障注入验证降级与恢复

## 下一篇

压测解决容量问题，日常更多是具体报错。最后一页是[常见问题排查手册](./common-issues.md)。
