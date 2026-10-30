---
title: 指标体系：延迟、错误率与 token
description: 网关需要哪些指标、怎么命名、如何设计分桶，以及 LLM 场景下最该盯的 TTFT 与 token 吞吐。
---

# 指标体系：延迟、错误率与 token

日志回答「这一次发生了什么」，指标回答「整体是不是在变坏」。两者的区别不只是数据量，而是**能不能做趋势和告警**——你不会想靠人肉翻日志来发现错误率从 1% 涨到了 8%。

## 先说结论

- 经典四信号（流量、延迟、错误、饱和度）依然适用，但 LLM 网关要额外关注 **TTFT、token 吞吐、缓存命中、降级占比**。
- **指标标签只放低基数字段**。`tenant_id` 要谨慎，`request_id`、`prompt` 绝对不能放。
- 延迟用直方图，分桶要覆盖到 60 秒以上，否则长上下文请求会全部落进 `+Inf`。
- 流式请求的「延迟」至少要拆成 **TTFT** 和 **总时长** 两个指标，只报总时长会掩盖首字体验问题。
- 告警基于 SLO，而不是基于单个瞬时指标。

## 指标清单

### 通用四信号

| 指标 | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `gateway_requests_total` | counter | `method, path, status, model_alias, provider` | 请求总数 |
| `gateway_request_duration_seconds` | histogram | `model_alias, provider, stream` | 端到端耗时 |
| `gateway_errors_total` | counter | `error_code, stage` | 标准化错误 |
| `gateway_inflight_requests` | gauge | `model_alias` | 并发中的请求数 |
| `gateway_upstream_inflight` | gauge | `provider` | 上游并发 |

### LLM 特有

| 指标 | 类型 | 说明 |
| --- | --- | --- |
| `gateway_ttft_seconds` | histogram | 首 token 延迟，流式必看 |
| `gateway_tokens_total` | counter | 按 `direction=input/output/cached` 拆分 |
| `gateway_tokens_per_second` | histogram | 生成速度，反映上游健康 |
| `gateway_cache_requests_total` | counter | 按 `result=hit/miss/bypass` 拆分 |
| `gateway_cache_saved_tokens_total` | counter | 缓存节省的输入 token |
| `gateway_route_attempts_total` | counter | 按 `target, attempt` 拆分 |
| `gateway_fallback_total` | counter | 降级/切换次数 |
| `gateway_circuit_state` | gauge | 0 关闭 / 1 半开 / 2 打开 |
| `gateway_cost_usd_total` | counter | 累计成本，按 `tenant` 谨慎使用 |
| `gateway_quota_rejected_total` | counter | 因限流/预算被拒的请求 |
| `gateway_upstream_retries_total` | counter | 重试次数 |

有了这组指标，你可以回答大部分线上问题：是流量涨了、上游慢了、还是我们在疯狂重试？

## 命名规范

Prometheus 生态的惯例是 `<namespace>_<subsystem>_<name>_<unit>`：

- 用**基本单位**：秒、字节、个数。不要用毫秒，否则 Grafana 里到处是 `/1000`。
- counter 以 `_total` 结尾。
- 同一个指标不要混用不同语义，比如不要用 `gateway_requests_total` 同时表示收到和发出。
- 标签值用小写下划线，不要放用户输入。

## 直方图分桶

默认分桶（`0.005` 到 `10` 秒）对 LLM 完全不够。长上下文请求动辄 30–60 秒，需要自定义：

```python
from prometheus_client import Histogram

REQUEST_DURATION = Histogram(
    "gateway_request_duration_seconds",
    "End-to-end gateway request duration",
    ["model_alias", "provider", "stream"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300),
)

TTFT = Histogram(
    "gateway_ttft_seconds",
    "Time to first token",
    ["model_alias", "provider"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30),
)

OUTPUT_TOKENS = Histogram(
    "gateway_output_tokens",
    "Output tokens per request",
    ["model_alias"],
    buckets=(16, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384),
)
```

分桶设计的两条经验：

1. **覆盖 P99 以上**。如果 5% 的请求超过最大桶，你的 P99 就是假的。
2. **在关键阈值附近加密**。SLO 是「P95 TTFT < 2s」，那就在 1.5/2/2.5 附近多放几个桶。

## 埋点代码

用中间件统一记录，避免每个 handler 各写一套：

```python
import time
from contextlib import contextmanager

from fastapi import Request
from prometheus_client import Counter, Gauge


REQUESTS = Counter(
    "gateway_requests_total", "Total requests",
    ["model_alias", "provider", "status", "stream"],
)
ERRORS = Counter(
    "gateway_errors_total", "Errors by code",
    ["error_code", "stage"],
)
INFLIGHT = Gauge(
    "gateway_inflight_requests", "In-flight requests", ["model_alias"],
)


@contextmanager
def observe_request(model_alias: str, provider: str, stream: bool):
    INFLIGHT.labels(model_alias).inc()
    start = time.perf_counter()
    status = "500"
    try:
        yield lambda s: None  # 调用方可通过返回值设置状态
    finally:
        duration = time.perf_counter() - start
        INFLIGHT.labels(model_alias).dec()
        REQUEST_DURATION.labels(model_alias, provider, str(stream).lower()).observe(duration)
```

实际项目中更常见的做法是把「状态码」通过 `request.state` 或返回值传出，而不是让 `finally` 猜。关键是**确保异常路径也会记录**，否则失败请求在指标里是隐形的。

### 流式请求的 TTFT

TTFT 必须在转发第一个数据块时记录，而不是请求结束时：

```python
async def relay_stream(upstream, request: Request, timer: PhaseTimer, labels: dict):
    first = True
    async for chunk in upstream.aiter_bytes():
        if first:
            timer.mark("first_token")
            TTFT.labels(**labels).observe(timer.elapsed_ms("first_token") / 1000)
            first = False
        await request.send(chunk)
    timer.mark("last_byte")
```

注意：`aiter_bytes()` 的第一个 chunk 不一定包含可见文本，可能只是 SSE 的 `role` 事件或注释行。如果你的上游会先发心跳，TTFT 会被低估。更精确的做法是**解析 SSE，等到第一个带 `delta.content` 的事件**再记录。

## 标签基数的陷阱

这是 Prometheus 最常见的线上事故：

| 标签 | 基数 | 是否可用 |
| --- | --- | --- |
| `model_alias` | 10–100 | ✅ |
| `provider` | 5–20 | ✅ |
| `status` | ~20 | ✅ |
| `error_code` | 20–50 | ✅ |
| `tenant_id` | 10–10 万 | ⚠️ 仅大客户或单独指标 |
| `key_id` | 数千以上 | ❌ 放日志 |
| `request_id` | 无限 | ❌ |
| `path`（含 ID） | 无限 | ❌ 用路由模板 |
| `prompt` / `user_id` | 无限 | ❌ |

每个标签组合都会生成一条时间序列。`tenant_id` × `model` × `status` 在千级租户下就能产生数十万序列，直接把 Prometheus 打爆。

需要按租户看数据时，用两条路：

1. **业务指标走日志/数仓**，Prometheus 只保留聚合值。
2. **为 Top N 租户单独打标签**，其余归入 `tenant="other"`。

## 核心 PromQL

```promql
# QPS（按模型）
sum by (model_alias) (rate(gateway_requests_total[5m]))

# 5xx 错误率
sum(rate(gateway_requests_total{status=~"5.."}[5m]))
/
sum(rate(gateway_requests_total[5m]))

# P95 TTFT
histogram_quantile(
  0.95,
  sum by (le, model_alias) (rate(gateway_ttft_seconds_bucket[5m]))
)

# P99 端到端延迟
histogram_quantile(
  0.99,
  sum by (le) (rate(gateway_request_duration_seconds_bucket[5m]))
)

# 缓存命中率
sum(rate(gateway_cache_requests_total{result="hit"}[5m]))
/
sum(rate(gateway_cache_requests_total{result=~"hit|miss"}[5m]))

# 降级占比
sum(rate(gateway_fallback_total[5m]))
/
sum(rate(gateway_requests_total[5m]))

# token 吞吐（tokens/s）
sum(rate(gateway_tokens_total{direction="output"}[5m]))

# 每分钟成本
sum(rate(gateway_cost_usd_total[5m])) * 60

# 上游并发饱和度（假设已知上限 200）
sum by (provider) (gateway_upstream_inflight) / 200
```

::: tip `histogram_quantile` 的聚合顺序
必须先 `sum by (le, ...)` 再算分位，不能对每个实例的分位数再求平均。多副本下直接 `avg(histogram_quantile(...))` 是错的——分位数不可加。
:::

## SLI 与 SLO

指标是原料，SLO 是承诺。网关至少定义三个 SLI：

| SLI | 定义 | 示例目标 |
| --- | --- | --- |
| 可用性 | 非 5xx 请求 / 总请求 | 99.9% / 30 天 |
| 首字延迟 | TTFT P95 | < 2s |
| 端到端延迟 | 非流式 P95 | < 15s |

注意「可用性」的口径：**上游 429 算不算网关不可用？** 从用户视角算（他没拿到结果），从平台视角不算（网关本身是好的）。建议拆成两个 SLI：

- `gateway_availability`：网关自身错误（认证、路由、内部异常）。
- `end_to_end_success`：用户最终拿到有效响应，包含上游因素。

这样上游抖动时，你知道该找谁。

错误预算的用法：30 天 99.9% 意味着约 43 分钟不可用。当预算消耗超过 50%，冻结非必要变更；超过 100%，进入事故复盘。这比「错误率超过 1% 就报警」更接近业务感受。

## 流式请求怎么算延迟

流式有三段时间，混在一起会误导：

| 阶段 | 含义 | 关注点 |
| --- | --- | --- |
| TTFT | 请求发出到首个可见 token | 用户感知的「响应速度」 |
| 生成时长 | 首 token 到最后一个 token | 输出长度、上游速度 |
| 总时长 | 请求发出到连接关闭 | 计费、超时配置 |

如果只监控总时长，一个「首字 8 秒、生成 1 秒」的请求和一个「首字 0.5 秒、生成 8.5 秒」的请求看起来一样，但用户体验完全不同，优化方向也完全不同。

还可以加一个派生指标：**tokens/s = output_tokens / 生成时长**。它下降通常意味着上游在限速或过载。

## 看板布局

一块好用的网关看板通常分四行：

1. **顶部结论**：QPS、错误率、P95 TTFT、P95 延迟、当前成本速率。
2. **流量与错误**：按模型/供应商的请求量堆叠图，错误码 Top 10。
3. **延迟**：TTFT 与总时长的分位曲线，按 `stream` 拆分。
4. **容量与路由**：上游并发、限流拒绝、降级次数、熔断状态、缓存命中率。

看板不是越多越好。值班同学打开第一屏就应该能判断「现在有没有事、大概在哪」。

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 把 `request_id` 放进标签 | 时间序列爆炸，Prometheus OOM |
| 只记录成功请求 | 错误率永远为 0 |
| 用总时长代替 TTFT | 首字体验问题被平均掉 |
| 默认分桶不调整 | 长请求全落 `+Inf`，P99 失真 |
| 对分位数求平均 | 多副本下结果错误 |
| 指标和日志各用一套 ID | 无法互相跳转 |
| 告警直接绑瞬时值 | 抖动导致告警疲劳 |

## Checklist

- [ ] 四信号 + TTFT + token 吞吐 + 缓存命中 + 降级占比都有指标
- [ ] 单位统一为秒/字节/个数
- [ ] 直方图分桶覆盖到 300 秒，且在 SLO 阈值附近加密
- [ ] 标签基数可控，无 `request_id`/`prompt`/无限 `path`
- [ ] `tenant_id` 只对 Top N 打标签，其余归入 `other`
- [ ] 流式请求单独记录 TTFT 与生成速度
- [ ] 多副本聚合使用 `sum by (le)` 后再算分位
- [ ] 定义网关可用性与端到端成功率两个 SLI
- [ ] 看板第一屏能判断「有没有事、在哪」
- [ ] 指标中的 `trace_id` 通过 exemplar 关联到日志

## 下一篇

指标负责发现异常，接下来要解决「怎么采集、怎么告警、怎么定位」：[OpenTelemetry 与告警](./otel-alerting.md)。
