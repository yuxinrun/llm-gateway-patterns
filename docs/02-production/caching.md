---
title: 缓存模式：结果、KV 与击穿防护
description: 精确响应缓存、语义缓存、Prompt/KV Cache 的区别，以及缓存键、失效、防击穿与成本测算。
---

# 缓存模式：结果、KV 与击穿防护

「给网关加个缓存」是句危险的话，因为至少有四种东西都叫缓存：

| 层 | 缓存的是什么 | 命中条件 | 省的是什么 | 主要风险 |
| --- | --- | --- | --- | --- |
| 精确响应缓存 | 完整响应 | 归一化请求完全一致 | 上游费用 + 延迟 | 数据串租户、结果过期 |
| 语义缓存 | 相似问题的答案 | 向量相似度超阈值 | 上游费用 + 延迟 | 答非所问 |
| Prompt / KV Cache | 上游内部的 prefix KV | 前缀完全一致 | 输入 token 费用 + 首 Token 延迟 | 前缀被破坏、厂商差异 |
| 自建推理 KV Cache | GPU 上的 KV block | 前缀 + 同一副本 | 计算量 | 显存、调度复杂度 |

把它们混在一起讨论，就会得出「缓存命中率上不去」或「缓存返回了别人的答案」这类结论。这一篇逐层拆开。

## 一、精确响应缓存

### 什么请求可以缓存

不是所有请求都适合。建议同时满足：

- `temperature == 0`（或业务明确接受确定性结果）
- 不包含用户隐私、订单、会话等个性化上下文
- 不涉及有副作用的工具调用
- 输出长度可控（例如 < 8KB）
- 业务能接受 TTL 内的旧答案

::: warning 默认不要跨租户共享缓存
即使 prompt 一样，返回内容也可能包含租户数据。缓存键必须带 `tenant_id`，或明确只对「公共知识问答」开启共享缓存。
:::

### 缓存键怎么设计

缓存键要覆盖所有会改变输出的因素：

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

几个细节：

- `sort_keys=True`：避免字段顺序导致同义请求不命中。
- 带上 `prompt_version`：模板一改，旧缓存自然失效。
- 带上 `group`：同一请求走不同路由组时，不应共用结果。
- 不要把 API Key 或用户 ID 放进键里做「伪隔离」，用租户命名空间。

### 缓存写入与防击穿

最危险的不是「不命中」，而是「同时不命中」：缓存刚过期，1000 个请求一起回源，把上游打挂。

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
            cached = await redis.get(key)      # 双重检查
            if cached:
                return json.loads(cached), True
            value = await loader()
            # TTL 加随机抖动，避免同一时刻集体过期
            await redis.set(key, json.dumps(value, ensure_ascii=False), ex=ttl + random.randint(0, 30))
            return value, False
        finally:
            await lock.release()

    # 没抢到锁：短暂等待，再查一次；仍没有则回源（要有限流兜底）
    await asyncio.sleep(0.2)
    cached = await redis.get(key)
    if cached:
        return json.loads(cached), True
    return await loader(), False
```

生产环境建议叠加两层：

1. **进程内 singleflight**：同一副本内相同 key 只发一次上游请求；
2. **stale-while-revalidate**：过期后先返回旧值，后台异步刷新。用户无感，上游压力平滑。

### 流式响应怎么缓存

原则：**只缓存完整结束的响应**，并且限制大小。

- 边转发边聚合文本；收到 `[DONE]` 后才写入缓存；
- 客户端中途断开，不写入（否则会缓存半截答案）；
- 回放时按固定大小切片，合成 `data: {...}` 与 `[DONE]`；
- 响应头加 `x-cache: hit`，并在 usage 里标明「未产生上游费用」。

::: danger 不要缓存错误
429、5xx、超时都可能是瞬时的。把错误缓存 5 分钟，会把一次抖动放大成一次故障。
:::

## 二、语义缓存

语义缓存用 embedding 判断「这两个问题是不是一个意思」，适合 FAQ、客服知识库这类高重复、低个性化场景。

```text
用户问题 -> embedding -> 向量检索 -> 相似度 >= 0.95? -> 返回缓存答案
                                      └─ 否 -> 调用模型 -> 写入缓存
```

必须设的限制：

- **按租户隔离**，或只对公共知识开启；
- **阈值要保守**（先从 0.95 起），并记录「语义命中但用户重问」的比例；
- **只用于纯问答**，不用于工具调用、代码执行、个性化推荐；
- **可一键关闭**：出问题时按路由组降级为精确缓存；
- **带 TTL**：知识会过期，语义相似不代表答案仍然正确。

::: warning 语义缓存是「可能答错」的缓存
精确缓存错了是「旧」，语义缓存错了是「答非所问」。如果业务对正确性极其敏感，宁可不做，或者只把它用在人工可兜底的场景。
:::

## 三、Prompt / KV Cache

这一层不在网关的 Redis 里，而在**模型提供方的推理系统**里。它缓存的是长前缀的 KV，命中后输入 token 更便宜、首 Token 更快。

### 前缀必须稳定

无论哪家厂商，核心规则都一样：**从第一个 token 开始，前缀必须完全一致**。

```text
❌ 每次请求都变的前缀
[system] 当前时间 2026-10-30 21:03:17，request_id=req_9f2c...
[docs]   ...... 8k tokens ......
[user]   帮我总结

✅ 稳定前缀
[system] 你是一个文档助手。以下是产品手册。
[docs]   ...... 8k tokens ......
[user]   帮我总结（变量放最后）
```

时间戳、request id、随机排序的 few-shot 示例，都会让缓存 100% 不命中。

### 三家厂商的差异

| 厂商 | 触发方式 | 前缀要求 | TTL | 计量字段（示例） |
| --- | --- | --- | --- | --- |
| Anthropic | 显式 `cache_control` 断点 | 精确匹配 | 默认约 5 分钟，可配更长 | `cache_creation_input_tokens` / `cache_read_input_tokens` |
| OpenAI | 自动，长 prompt 达到阈值 | 精确匹配 | 分钟级 | `cached_tokens` |
| Gemini | 显式 cached content | 精确匹配 | 可配置 | `cachedContentTokenCount` |
| 自建 vLLM | 自动 prefix caching | 前缀 + 副本 | 显存决定 | 本地指标 |

::: tip 以官方文档为准
TTL、最小 token 数、折扣比例都会调整。网关不要把价格写死，做成配置并定期校准。
:::

### 网关能做什么

1. **稳定前缀**：把时间、request id 等易变字段移到末尾或 metadata。
2. **注入缓存断点**：对支持的厂商，在 system / 文档 / few-shot 后插入 `cache_control`。
3. **记录命中**：从 usage 里提取 cached token，按租户统计节省。
4. **保持亲和**：同一前缀尽量路由到同一厂商与模型，避免「刚缓存就切走」。
5. **保护隐私**：跨租户共享前缀要非常谨慎，最好按租户命名空间隔离。

Anthropic 风格的断点注入示意：

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

### 自建推理：KV Cache 代理

如果你自己部署 vLLM / SGLang，KV Cache 在 GPU 显存里。网关能做的是**前缀感知路由**：

```text
prefix_hash = hash(system + tools + docs)
replica = consistent_hash(prefix_hash, healthy_replicas)
```

同一前缀尽量落到同一副本，才能命中该副本的 prefix cache。扩容、缩容、故障切换都会导致缓存失效，这是必须接受的成本。

::: warning 不要承诺「跨厂商共享 KV Cache」
不同厂商的 KV 结构、位置编码、模型权重都不同，KV 无法跨模型复用。网关能做的是「让同一前缀在同一个地方被反复命中」，不是「把 KV 搬来搬去」。
:::

## 四、算一笔缓存账

假设每天 10 万次请求，平均输入 8,000 tokens，其中 70% 命中前缀缓存，缓存读取价格为正常输入的 10%：

| 项目 | 计算 | 结果 |
| --- | --- | --- |
| 每日输入 token | 100,000 × 8,000 | 8 亿 |
| 命中缓存的 token | 8 亿 × 70% | 5.6 亿 |
| 未命中 token | 2.4 亿 | 2.4 亿 |
| 若单价 $3 / 百万 token | 无缓存成本 | $2,400 / 天 |
| 缓存后输入成本 | 2.4 亿 × $3/M + 5.6 亿 × $0.3/M | $888 / 天 |
| 每日节省 | — | 约 $1,512 |

数字是示意，但结论稳定：**前缀越长、复用越高，Prompt Cache 的收益越大**。短 system prompt、一次性问答，收益有限。

## 反模式

::: danger 缓存键漏了模型或版本
换模型后仍然命中旧答案，看起来「省钱」，实际是「答错」。模型别名、prompt 版本、路由组都要进键。
:::

::: danger 跨租户共享个性化答案
用户 A 的订单摘要被用户 B 命中，这是数据事故，不是缓存优化。
:::

::: danger 缓存工具调用结果
工具结果有时效性与副作用。除非工具本身明确幂等且可缓存，否则不要碰。
:::

::: danger 没有 TTL 与容量上限
Redis 会被慢慢撑爆，或者缓存永远不失效。设置 TTL、最大条目数、单条大小上限。
:::

::: danger 把语义缓存当默认开关
语义缓存应该按场景白名单开启，而不是全站默认。错一次，用户信任就没了。
:::

## 检查清单

- [ ] 明确当前启用的是哪一层缓存
- [ ] 缓存键包含租户、模型别名、prompt 版本、采样参数
- [ ] 只缓存成功且完整的响应
- [ ] TTL 有抖动，容量有上限
- [ ] 有 singleflight 或分布式锁防击穿
- [ ] 流式缓存只存完整结果，支持 `x-cache: hit`
- [ ] 语义缓存按租户隔离、阈值可调、可关闭
- [ ] Prompt 前缀稳定，易变字段后置
- [ ] 记录 cached token 与命中率
- [ ] 明确「不跨厂商共享 KV」的边界

下一篇：[限流与配额](./rate-limit.md)，把「谁能用多少」管起来。
