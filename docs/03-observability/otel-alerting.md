---
title: OpenTelemetry 与告警
description: 用 OTel 统一 traces、metrics、logs，按 GenAI 语义约定埋点，并设计基于 SLO 的告警与值班手册。
---

# OpenTelemetry 与告警

一个典型的翻车现场：日志在 Loki、指标在 Prometheus、链路在 Jaeger，三套系统三个 ID，出问题时你在三个页面之间反复横跳，最后还是靠猜。OpenTelemetry 的价值不是「多一个 SDK」，而是**让三类信号共享同一套资源与上下文**。

## 先说结论

- 用 **OTLP** 作为统一出口，后端可以换（Tempo、Jaeger、Datadog、阿里云 ARMS），埋点代码不换。
- 上游调用按 **GenAI 语义约定**命名属性和 span，未来接任何支持该约定的平台都能直接识别。
- **流式请求的 span 在最后一个字节才结束**，TTFT 作为事件/属性记录，不要在流未结束时提前 `end()`。
- 告警按 **症状** 而不是按原因：用户感受到的是「错误率高」和「首字慢」，不是「某个 counter 涨了」。
- 每个告警必须配 runbook，否则它只是一个噪音源。

## 三类信号怎么分工

| 信号 | 回答的问题 | 保留期 | 成本 |
| --- | --- | --- | --- |
| Traces | 这一次请求慢在哪 | 3–14 天 | 高 |
| Metrics | 整体趋势、是否越界 | 数月–数年 | 低 |
| Logs | 具体上下文、异常堆栈 | 7–30 天 | 中 |

实践中的组合是：**metrics 发现 → trace 定位 → log 看细节**。所以三者的关联 ID 必须一致：同一个 `trace_id` 要能从 Grafana 的指标 exemplar 跳到 Tempo，再从 span 跳到 Loki 的日志。

## GenAI 语义约定

OpenTelemetry 为生成式 AI 定义了一组属性。不同语言 SDK 和 Collector 版本的支持程度不同，以下是最常用的一组（以官方 semconv 文档为准）：

| 属性 | 示例 | 说明 |
| --- | --- | --- |
| `gen_ai.system` | `openai` | 供应商标识 |
| `gen_ai.operation.name` | `chat` | 操作类型 |
| `gen_ai.request.model` | `gpt-4o-mini` | 请求的模型 |
| `gen_ai.response.model` | `gpt-4o-mini-2024-07-18` | 实际返回的模型 |
| `gen_ai.request.max_tokens` | `1024` | 最大输出 |
| `gen_ai.request.temperature` | `0.7` | 采样温度 |
| `gen_ai.usage.input_tokens` | `1832` | 输入 token |
| `gen_ai.usage.output_tokens` | `517` | 输出 token |
| `gen_ai.response.finish_reasons` | `["stop"]` | 结束原因 |

::: warning 约定仍在演进
GenAI semconv 目前仍带实验性质，属性名可能调整。建议在代码里集中定义常量，升级时只改一处；同时保留自定义前缀（如 `lgw.*`）承载网关特有的字段，避免和标准属性冲突。
:::

网关特有的属性建议单独命名：

| 属性 | 说明 |
| --- | --- |
| `lgw.tenant_id` | 租户 |
| `lgw.route.group` | 路由组 |
| `lgw.route.attempt` | 第几次尝试 |
| `lgw.cache.result` | hit / miss / bypass |
| `lgw.ttft_ms` | 首 token 耗时 |
| `lgw.cost_usd` | 本次成本 |
| `lgw.fallback.from` | 从哪个目标降级 |

## Python 接入

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

resource = Resource.create({
    "service.name": "llm-gateway",
    "service.version": "1.4.2",
    "deployment.environment": "prod",
    "cloud.region": "cn-hangzhou",
})

provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint="http://otel-collector:4318/v1/traces"),
        max_queue_size=4096,
        max_export_batch_size=512,
        schedule_delay_millis=2000,
    )
)
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("llm_gateway")
```

`BatchSpanProcessor` 是必须的。同步导出会在每次请求里阻塞网络 IO，高峰期直接把延迟打上去。队列满了会丢 span，所以要监控 `dropped_spans` 相关指标。

### 手写上游 span

```python
from opentelemetry.trace import Status, StatusCode


async def call_upstream(target, payload, timer):
    with tracer.start_as_current_span("upstream.chat") as span:
        span.set_attributes({
            "gen_ai.system": target.provider,
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": target.model,
            "lgw.route.group": target.group,
            "lgw.route.attempt": target.attempt,
            "server.address": target.host,
        })

        try:
            response = await client.post(target.url, json=payload)
        except httpx.TimeoutException as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, "upstream_timeout"))
            raise

        span.set_attribute("http.response.status_code", response.status_code)
        if response.status_code >= 500:
            span.set_status(Status(StatusCode.ERROR, "upstream_5xx"))
        return response
```

### 流式 span 的正确结束时机

流式请求最容易写错的地方：`client.stream()` 的上下文管理器在拿到响应头时就退出了，如果你在 `with` 块结束时 span 就 `end()`，那整段生成时间都不在 span 里。

```python
async def stream_upstream(target, payload, timer):
    span = tracer.start_span("upstream.chat.stream")
    span.set_attribute("gen_ai.request.model", target.model)
    try:
        async with client.stream("POST", target.url, json=payload) as response:
            span.set_attribute("http.response.status_code", response.status_code)
            async for chunk in response.aiter_bytes():
                if timer.ttft_ms is None:
                    timer.mark("first_token")
                    span.add_event("first_token", {"lgw.ttft_ms": timer.elapsed_ms("first_token")})
                yield chunk
    except Exception as exc:
        span.record_exception(exc)
        span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
        raise
    finally:
        span.set_attribute("lgw.duration_ms", timer.elapsed_ms())
        span.end()
```

三个要点：

1. **span 手动管理**，不要用 `with`，因为要跨生成器生命周期。
2. **TTFT 用 event**，它有时间戳，比单纯一个属性信息量更大。
3. **客户端主动断开也要 `end()`**，放在 `finally` 里，否则 span 泄漏。

### 上下文传播

异步任务、线程池、消息队列都会丢上下文。凡是「请求之后还要继续做」的事情（计费、审计、异步回调），都要显式传递：

```python
import asyncio
from opentelemetry import context as otel_context


def spawn_tracked(coro):
    ctx = otel_context.get_current()
    return asyncio.create_task(coro, context=ctx)
```

Python 3.11+ 的 `create_task` 支持 `context` 参数。旧版本可以用 `contextvars.copy_context()` 包一层。

## OTel 还是 Prometheus

两条路线经常被混用，实际选择取决于你的后端：

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| Prometheus client 直接暴露 `/metrics` | 生态成熟、PromQL 强大 | 只覆盖指标 |
| OTel SDK 同时产出三类信号 | 统一上下文、后端可换 | 指标生态稍弱、资源开销更高 |
| 混合：指标走 Prometheus，链路走 OTel | 各取所长 | 需要保证 `trace_id` 能关联 |

推荐混合方案，但**只在一个地方定义业务语义**。比如 TTFT 的分桶和标签定义在一个模块里，Prometheus 和 OTel 都从它读取，避免两套口径。

## Collector 管道

不要让应用直接对接多个后端。中间放一个 Collector，负责批处理、采样、脱敏和路由：

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 1024
    spike_limit_mib: 256
  batch:
    timeout: 5s
    send_batch_size: 1024
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 10000 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
  attributes:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: lgw.prompt
        action: delete

exporters:
  otlphttp/tempo:
    endpoint: http://tempo:4318
  prometheus:
    endpoint: 0.0.0.0:8889
  loki:
    endpoint: http://loki:3100/loki/api/v1/push

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlphttp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes, batch]
      exporters: [loki]
```

几个实践点：

- `memory_limiter` 必须放在最前面，Collector 被 OOM 会丢所有信号。
- `tail_sampling` 要等 `decision_wait`，太短会导致「错误 span 还没到就做了决定」。
- 脱敏放在 Collector 而不是应用，好处是规则集中管理，坏处是敏感数据已经离开了进程。高敏场景应该在应用侧先删。
- 多 Collector 副本时，tail sampling 需要按 `trace_id` 做负载均衡（`loadbalancing` exporter），否则同一个 trace 的 span 散落在不同实例，采样决策不完整。

## 告警设计

### 按症状告警

| 告警 | 表达式（示例） | 持续 | 级别 |
| --- | --- | --- | --- |
| 错误率高 | `job:gateway_error_ratio:5m > 0.05` | 5m | P1 |
| 首字变慢 | `job:gateway_ttft_p95:5m > 3` | 10m | P2 |
| 端到端变慢 | `job:gateway_latency_p95:5m > 20` | 10m | P2 |
| 全量降级 | `sum(rate(gateway_fallback_total[5m])) / sum(rate(gateway_requests_total[5m])) > 0.3` | 5m | P1 |
| 预算消耗过快 | `predict_linear(gateway_cost_usd_total[6h], 86400) > budget * 2` | 15m | P2 |
| 缓存击穿 | `gateway_cache_requests_total{result="hit"} / ignoring(result) sum(...) < 0.1` | 15m | P3 |
| 上游熔断 | `gateway_circuit_state == 2` | 2m | P2 |
| 采集断流 | `up == 0` | 2m | P1 |

「持续」这一列非常重要。瞬时阈值会让告警在抖动中反复触发，值班同学很快就学会忽略它。

### 多窗口燃烧率

单阈值告警要么太钝要么太吵。SLO 燃烧率（burn rate）同时看长短窗口，兼顾灵敏度和稳定性：

```yaml
groups:
  - name: gateway-slo
    rules:
      - alert: GatewayErrorBudgetFastBurn
        expr: |
          (
            job:gateway_error_ratio:5m > (14.4 * 0.001)
            and
            job:gateway_error_ratio:1h > (14.4 * 0.001)
          )
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "网关错误预算快速燃烧"
          runbook: "https://github.com/yuxinrun/llm-gateway-patterns/blob/main/docs/03-observability/otel-alerting.md"

      - alert: GatewayErrorBudgetSlowBurn
        expr: |
          (
            job:gateway_error_ratio:30m > (6 * 0.001)
            and
            job:gateway_error_ratio:6h > (6 * 0.001)
          )
        for: 15m
        labels:
          severity: ticket
```

这里假设 SLO 是 99.9%（错误预算 0.001）。`14.4` 和 `6` 是常用的燃烧率倍数：短窗口抓突发，长窗口防误报。

### 告警分级

| 级别 | 含义 | 响应 | 通知方式 |
| --- | --- | --- | --- |
| P1 | 用户大面积不可用 | 立即 | 电话 + 群 |
| P2 | 体验明显下降或有超支风险 | 30 分钟内 | 群 + 工单 |
| P3 | 趋势异常，暂不影响用户 | 当天 | 工单 |
| P4 | 信息性 | 周报 | 看板 |

分级的意义在于**限制 P1 的数量**。如果每晚都有三个 P1，分级就失效了。

### 抑制与静默

- **抑制**：上游整体故障时，抑制所有下游派生告警，只保留根因那条。
- **静默**：计划内变更（发版、扩容）提前静默，但必须设置过期时间，避免「静默忘了关」。
- **分组**：按 `service` + `alertname` 聚合，避免一次故障刷 200 条。

```yaml
inhibit_rules:
  - source_match:
      alertname: GatewayUpstreamDown
    target_match_re:
      alertname: Gateway(ErrorRateHigh|TTFTSlow)
    equal: ["provider"]
```

## Runbook 写什么

每个 P1/P2 告警都应该有一个可以直接照着做的页面：

1. **现象**：用户看到什么，指标长什么样。
2. **影响面**：哪些租户、哪些模型、是否全量。
3. **快速判断**：三条命令或三个看板链接，用来区分「我们的问题」还是「上游的问题」。
4. **止损动作**：切流、降级、限流、回滚，按代价从低到高排列。
5. **升级路径**：多久没恢复找谁。
6. **事后**：需要保留哪些现场数据。

没有 runbook 的告警，建议直接降级为工单，不要叫醒人。

## 成本与 token 告警

除了可用性，成本也值得单独告警：

```promql
# 单租户小时成本超过其日均的 5 倍
sum by (tenant) (increase(gateway_cost_usd_total[1h]))
>
5 * avg_over_time(sum by (tenant) (increase(gateway_cost_usd_total[1h] offset 1d))[7d:1h])
```

以及 token 层面的异常：

- 单请求输出 token 超过 P99 的 10 倍 → 可能是死循环或提示词问题。
- 输入 token 突然翻倍 → 上下文拼接逻辑变了。
- `usage_source="estimated"` 占比上升 → 上游 usage 字段异常，账目可信度下降。

## 反模式

| 反模式 | 问题 |
| --- | --- |
| 每个异常都发 P1 | 告警疲劳，真正的事故被淹没 |
| 告警没有 runbook | 值班同学只能凭经验猜 |
| 用原因指标告警（如「重试次数 > 10」） | 重试成功时用户毫无感知，却天天被叫醒 |
| 同步导出 span | 高峰期延迟雪崩 |
| 流式 span 提前结束 | 生成阶段完全不可见 |
| Collector 无内存限制 | OOM 后所有信号一起丢 |
| 脱敏只做正则 | 姓名、地址、内部代号照样泄露 |
| 采样把错误也采掉 | 事故时没有现场 |

## Checklist

- [ ] 使用 OTLP 统一出口，后端可替换
- [ ] 上游 span 使用 GenAI 语义约定 + `lgw.*` 自定义属性
- [ ] 流式 span 在最后一个字节结束，TTFT 以 event 记录
- [ ] `BatchSpanProcessor` 已启用，并监控丢弃量
- [ ] Collector 配置 `memory_limiter`、`batch`、尾部采样
- [ ] 敏感头与 prompt 在采集链路中被删除
- [ ] 告警按症状设计，均有持续时间和分级
- [ ] SLO 使用多窗口燃烧率，而非单阈值
- [ ] P1/P2 告警都有 runbook 链接
- [ ] 配置抑制规则，避免一次故障刷屏
- [ ] 成本与 `usage_source` 异常有独立告警

## 下一篇

可观测体系到这里就完整了。接下来进入实战：先看最常见的[多厂商混合接入与自动故障转移](../04-scenarios/multi-vendor-failover.md)。
