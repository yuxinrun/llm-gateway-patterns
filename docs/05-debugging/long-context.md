---
title: 长上下文与性能边界
description: 128k 窗口不等于 128k 有效上下文。理解 token 成本、首字延迟与注意力稀释，做出正确的长度策略。
---

# 长上下文与性能边界

模型宣称支持 128k，不代表你应该塞满 128k。实际使用中，**长上下文会同时推高三样东西：费用、首字延迟、以及回答出错率**。很多团队栽在「窗口够大，那就都放进去」这个直觉上。

## 先说结论

- **窗口上限是硬约束，有效上下文是软约束**。中间位置的信息最容易被忽略。
- **输入 token 线性增加费用，首字延迟也近似线性增加**。128k 输入的 TTFT 可能是 8k 的十倍以上。
- **长度路由要在转发前完成**，用估算 + 安全余量，不要等上游返回 400。
- **压缩优于截断**。截断会静默丢信息，摘要和检索能保留关键内容。
- **长上下文请求要单独限流**，否则一个请求就能吃掉整个租户的 TPM。
- **长上下文和前缀缓存是好朋友**：固定的长文档放前面，能显著降本。

## 窗口不等于有效上下文

学术界用「大海捞针」（needle in a haystack）测试长上下文召回，结论相当一致：

- 信息在**开头和结尾**时召回最好。
- 信息在**中间**时召回明显下降，这就是常说的 lost in the middle。
- 随着长度增加，即使能召回，**推理质量也会下降**。
- 多跳问题（需要组合多处信息）比单点查找更难。

所以正确的问法不是「能不能放下」，而是「放进去之后模型还能不能用好」。

| 上下文长度 | 典型表现 | 建议 |
| --- | --- | --- |
| < 8k | 稳定 | 常规使用 |
| 8k–32k | 多数任务可用 | 注意中间信息 |
| 32k–128k | 单点检索尚可，推理下降 | 优先压缩，关键信息前置 |
| > 128k | 成本与延迟都很高 | 只用于必要场景，且要评测 |

## 长上下文的四项成本

### 1. Token 费用

输入 token 按量计费，长度线性增长。假设输入价 $3/M：

| 输入长度 | 单次成本 | 每日 10 万次 |
| ---: | ---: | ---: |
| 4k | $0.012 | $1,200 |
| 32k | $0.096 | $9,600 |
| 128k | $0.384 | $38,400 |

如果每次都把整份文档塞进去，成本会随文档长度线性膨胀，而大多数请求只用到其中一小段。

### 2. 首字延迟

预填充阶段要处理全部输入 token，TTFT 随长度增长。不同硬件和模型差异很大，但趋势一致：**输入翻倍，TTFT 大致也翻倍**（在带宽受限时更明显）。

对交互式产品，TTFT 超过 3 秒用户就开始怀疑卡了。一个 100k 输入的请求，TTFT 到 10 秒并不罕见。

### 3. KV Cache 显存

自建推理时，KV cache 占用与「序列长度 × 层数 × 隐藏维度」成正比。长上下文会显著降低并发能力：

```text
可用显存固定 → 单请求 KV 越大 → 同时能跑的请求越少
```

这也是为什么长上下文请求要单独限流：它占用的不是「一个请求名额」，而是「好几个普通请求的显存」。

### 4. 注意力稀释

上下文越长，模型在无关内容上分配的注意力越多。表现是：

- 指令遵循变差（忽略了 system 里的格式要求）。
- 事实性下降（把相似但错误的内容混进来）。
- 输出变啰嗦（试图覆盖所有内容）。

## 先算清楚 token

所有长度决策都依赖准确的 token 计数。三个来源：

| 来源 | 精度 | 成本 |
| --- | --- | --- |
| 厂商 tokenizer | 高 | 需要加载对应分词器 |
| 通用估算（字符/4） | 中英混合误差大 | 零成本 |
| 上游返回的 usage | 准，但事后 | 无法用于事前拦截 |

网关需要**事前估算**，事后再用真实 usage 校准。建议维护一个按模型的系数表：

```python
def estimate_tokens(text: str, model: str) -> int:
    # 中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other = len(text) - cjk
    base = cjk + other / 4
    factor = MODEL_FACTORS.get(model, 1.05)   # 留 5% 余量
    return int(base * factor)
```

多模态内容要单独算：图片按分辨率折算（不同厂商公式不同），音频按秒。工具 schema 也要计入，几十个工具的 JSON 可能有几千 token。

::: warning 估算只用于拦截
估算的误差可能到 20%。用它做「是否超限」的判断时要留足余量；**计费一律用上游返回的 usage**。
:::

## 长度路由

按估算长度选择目标，而不是所有请求都走最大窗口的模型：

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

注意 `need` 要加上 `max_tokens`：只按输入选目标，输出阶段仍可能超限。

### 预留输出空间

很多 400 错误来自「输入刚好卡在上限」：

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

错误信息里给出可操作的建议，比一句 "context length exceeded" 有用得多。

## 压缩策略

| 策略 | 保留信息 | 成本 | 适用 |
| --- | --- | --- | --- |
| 头部截断 | 开头 | 低 | system + 最新问题 |
| 滑动窗口 | 最近 N 轮 | 低 | 聊天 |
| 摘要压缩 | 全局要点 | 中（要调用模型） | 长对话、会议记录 |
| 检索增强 | 相关片段 | 中 | 知识库问答 |
| 结构化提取 | 关键字段 | 低 | 表格、日志、JSON |
| 外置引用 | 引用 ID | 低 | 工具结果、文档 |

### 滑动窗口 + 摘要

聊天场景最常见的组合：保留最近 N 轮原文，更早的内容压缩成摘要。

```python
def build_context(history: list[dict], summary: str | None, max_tokens: int) -> list[dict]:
    messages = []
    if summary:
        messages.append({"role": "system", "content": f"早前对话摘要：{summary}"})

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

摘要本身也要控制长度，否则「摘要比原文还长」。

### 检索优于全量

如果任务是「从文档里找答案」，检索 5 个相关片段通常比塞入整份文档效果更好、成本更低。长上下文不是 RAG 的替代品，**它只是把「检索」这一步推迟到了模型内部**，而且模型的检索能力远不如专用检索系统可控。

## 长上下文与缓存

长文档最适合做前缀缓存：内容固定、token 多、复用次数高。

```text
[缓存前缀] 完整文档 / 代码库 / 手册
[变化部分] 用户问题
```

前提是：

- 文档顺序稳定（不要每次重新排序段落）。
- 文档内容不插入时间戳、随机 ID。
- 同一租户的请求路由到同一上游（供应商缓存是组织级，自建缓存是实例级）。

一份 100k 的文档，缓存读价格通常是普通输入的 1/10，TTFT 也会显著下降。这是长上下文场景里性价比最高的优化。

## 长上下文与超时

长输入的预填充时间可能超过默认超时。要按长度动态调整：

```python
def timeout_for(input_tokens: int, stream: bool) -> httpx.Timeout:
    base = 30 + input_tokens / 1000 * 0.8   # 粗略：每千 token 0.8 秒
    first_byte = min(base, 180)
    return httpx.Timeout(
        connect=10.0,
        read=600.0 if stream else first_byte + 60,
        write=30.0,
        pool=10.0,
    )
```

对非流式请求，长输入 + 长输出很容易超过 60 秒。建议**对长上下文强制使用流式**，既改善体验，也避免代理层超时。

## 长上下文与限流

| 维度 | 建议 |
| --- | --- |
| 单请求输入上限 | 按套餐设置，比如 Free 32k、Pro 128k |
| 单请求 TPM 折算 | 一个 100k 请求按 100k 计入 TPM |
| 并发 | 长请求单独信号量，避免占满普通请求 |
| 超时 | 按长度分级 |
| 成本预估 | 转发前预估并预留预算 |

如果没有单请求上限，一个用户上传 500 页 PDF 就能把当天的预算打光。

## 怎么评测

不要凭感觉判断「长上下文能不能用」，做一个小型评测：

1. **针尖测试**：在文档不同位置放入一个事实，问模型。记录首/中/尾的准确率。
2. **多跳测试**：需要组合两处信息才能回答的问题。
3. **干扰测试**：放入相似但错误的信息，看模型是否被误导。
4. **格式遵循**：长上下文下是否还遵守输出格式要求。
5. **成本与延迟**：记录 TTFT、总时长、token 数。

评测集不用很大，几十条就能看出趋势。关键是**用你自己的数据**，公开榜单和你的场景往往差很远。

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 能塞多少塞多少 | 成本、延迟、准确率三输 |
| 只按输入长度选模型 | 输出阶段仍可能超限 |
| 用上游 400 做长度校验 | 付费后才失败 |
| 截断不留标记 | 模型看到残缺内容却不知道 |
| 长请求不限流 | 单请求吃满租户配额 |
| 长文档每次重排 | 前缀缓存全部失效 |
| 用长上下文替代检索 | 成本高且不可控 |
| 不做评测就上线 | 不知道效果是变好还是变差 |

## Checklist

- [ ] 明确区分「窗口上限」与「有效上下文」
- [ ] token 估算覆盖文本、图片、工具 schema，并留安全余量
- [ ] 转发前校验 `输入 + max_tokens`，超限返回 413
- [ ] 按长度分档路由，长请求走大窗口模型
- [ ] 有滑动窗口/摘要/检索等压缩策略
- [ ] 长文档使用前缀缓存，顺序稳定
- [ ] 超时按输入长度动态调整，长请求优先流式
- [ ] 单请求输入上限与并发上限按套餐配置
- [ ] 用自有数据做过针尖与多跳评测
- [ ] 长请求的 TTFT、成本、错误率单独监控

## 下一篇

知道了单个请求的边界，接下来看整体容量：[压测与瓶颈定位](./load-testing.md)。
