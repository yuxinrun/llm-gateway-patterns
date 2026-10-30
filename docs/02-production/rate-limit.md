---
title: 限流与配额：RPM/TPM 分级
description: RPM、TPM、并发与预算的限流模型，分布式令牌桶实现，以及租户分级配额。
---

# 限流与配额：RPM/TPM 分级

限流不是「拒绝用户」，而是**把有限的模型容量分配给最重要的人**。没有限流，一个脚本就能让整个平台 429。

## 先分清五个维度

| 维度 | 管什么 | 典型场景 |
| --- | --- | --- |
| RPM | 每分钟请求数 | 防止高频小请求打爆连接 |
| TPM | 每分钟 token 数 | 防止长上下文把上游配额吃光 |
| 并发流 | 同时进行中的流式请求 | 防止连接与显存被占满 |
| 日/月预算 | 金额或 token 总量 | 防止跑飞与账单事故 |
| 工具/任务配额 | 单次 Agent run 的调用次数 | 防止循环失控 |

只用 RPM 会漏掉「一个请求 100 万 token」；只用 TPM 会漏掉「大量空请求占用连接」。**RPM + TPM + 并发**是最小组合。

## 算法怎么选

| 算法 | 优点 | 缺点 | 适合 |
| --- | --- | --- | --- |
| 固定窗口 | 实现最简单 | 窗口边界会出现双倍突发 | 粗粒度保护 |
| 滑动窗口日志 | 精确 | 内存随请求量增长 | 低频精确计数 |
| 滑动窗口计数 | 精度与内存平衡 | 仍是近似 | 通用 API 限流 |
| 令牌桶 | 允许可控突发 | 参数需要调 | 模型调用入口 |
| 漏桶 | 输出平滑 | 不允许突发 | 保护脆弱上游 |

推荐：**入口用令牌桶（允许短突发），预算用滑动窗口/累计计数，并发用信号量**。

### 分布式令牌桶

多副本部署时，计数不能放进程内存。下面是一段 Redis Lua，把「读-算-写」做成原子操作：

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

Python 侧：

```python
import time
from redis.asyncio import Redis

LUA = """...上面的脚本..."""

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

::: tip 参数怎么定
`capacity` 是允许的突发量，`refill` 是长期速率。例如 RPM=600，可取 `capacity=100`、`refill=10/s`：允许 10 秒的突发，长期不超过 600/分钟。
:::

## TPM 怎么算才不亏

token 不像请求数，**请求开始时还不知道会生成多少**。推荐「预留 + 结算」：

1. 估算输入 token（tokenizer 或保守的字符比例）；
2. 预留 `输入 + max_tokens`；
3. 上游返回后，用真实 usage 结算差额；
4. 失败请求释放预留。

```python
def estimate_tokens(text: str) -> int:
    # 粗略估算：英文约 4 字符/token，中文约 1.5 字符/token
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    other_chars = len(text) - ascii_chars
    return max(1, ascii_chars // 4 + int(other_chars / 1.5))
```

::: warning 估算只用于预留，不用于计费
计费必须优先使用上游返回的 usage。估算值只用于限流预检，并保留 10%～20% 安全余量。
:::

### 缓存 token 怎么计

Prompt Cache 命中后，上游按折扣计费，但**你的配额策略未必要跟着打折**：

- 如果配额是「成本上限」：按折后成本计；
- 如果配额是「资源占用」：按原始 token 计，避免用户滥用长前缀。

两种都合理，关键是写进产品规则，而不是让实现悄悄决定。

## 租户分级

典型的三层结构：

```text
Organization（企业）
  └── Project（业务/环境）
        └── API Key（服务/开发者）
```

生效配额建议：

```text
effective_limit = key_override
                ?? project_limit
                ?? org_limit
                ?? plan_default
```

| 套餐 | RPM | TPM | 并发流 | 日预算 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Free | 60 | 60k | 5 | $5 | 试用 |
| Pro | 600 | 600k | 50 | $100 | 小团队 |
| Enterprise | 自定义 | 自定义 | 自定义 | 自定义 | 独立池/专属实例 |

::: warning 配额继承要能「覆盖」而不是「相加」
父级 100 万 TPM、子项目 10 万 TPM，子项目应该是 10 万，而不是 110 万。继承规则要写清楚，并在管理后台可视化。
:::

## 429 要回什么

只回一个 `{"error":"too many requests"}`，客户端只能盲目重试。建议带上可行动信息：

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

区分两种 429：

- `rate_limit_exceeded`：短期限流，可退避重试；
- `quota_exceeded`：周期预算用尽，重试无意义，要升级套餐或等下一个周期。

## 并发流与队列

流式请求会长时间占用连接。并发限制建议两级：

1. **租户级信号量**：防止单租户占满；
2. **上游目标级信号量**：保护某个厂商/模型。

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

队列超时不要设太长：排队 30 秒再开始生成，用户体验和成本都不划算。

## 上游限流也要管

你自己的配额是「允许用户用多少」，上游的 RPM/TPM 是「厂商允许你用多少」。两者取小：

```text
effective = min(tenant_quota, provider_quota / replica_count, adaptive_limit)
```

自适应并发可以用 AIMD：

- 连续成功：缓慢增加并发上限（+1）；
- 遇到 429 / 超时：减半，并进入冷却；
- 冷却期内不增加。

这比固定并发更能适应上游的真实容量。

## 反模式

::: danger 每个副本各自计数
3 个副本、每副本 600 RPM，实际就是 1800 RPM。要么用 Redis，要么按副本数除以配额。
:::

::: danger 只限请求数，不限 token
一个 200k token 的请求，可能比 100 个小请求更贵、更慢。
:::

::: danger 固定窗口卡边界
第 59 秒 600 个请求，第 61 秒又来 600 个，上游会在两秒内收到 1200 个。
:::

::: danger 429 后立刻重试
没有退避和抖动的重试，会把限流变成雪崩。重试必须占用重试预算。
:::

::: danger 把配额当计费
配额是「允不允许」，计费是「收多少钱」。两者可以相关，但不能混为一谈。
:::

## 检查清单

- [ ] RPM、TPM、并发、预算四个维度都有策略
- [ ] 计数在分布式存储中原子更新
- [ ] TPM 采用「预留 + 结算」，有安全余量
- [ ] 配额层级支持覆盖与可视化
- [ ] 429 带 `Retry-After` 与配额响应头
- [ ] 区分短期限流与周期配额
- [ ] 流式并发有租户级与目标级限制
- [ ] 上游 429 触发退避，不盲目重试
- [ ] Redis 故障时明确 fail-open / fail-closed 策略

下一篇：[鉴权隔离与多租户](./auth-tenant.md)，解决「你是谁、能用什么」。
