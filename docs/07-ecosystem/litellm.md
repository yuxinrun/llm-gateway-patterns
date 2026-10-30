---
title: LiteLLM 高级配置模板
description: 用一份可用的 config.yaml 配置多模型路由、虚拟 Key、预算、回退与可观测，并判断何时该自研。
---

# LiteLLM 高级配置模板

LiteLLM 是开源网关里起步最快的一个：一份 YAML 就能接上几十家供应商，自带虚拟 Key、预算、回退和日志回调。但它不是银弹——当你的需求超出它的抽象边界时，改造成本会迅速上升。

这一页给一份偏生产化的配置模板，并说明哪些能力可以直接用、哪些需要二次开发。

::: tip 版本差异
LiteLLM 迭代很快，配置字段可能随版本调整。下面的模板以 Proxy 的常见配置为准，落地前请对照你使用的版本文档校验。
:::

## 先说结论

- **LiteLLM 适合「快速拥有一个可用的多模型网关」**，尤其是团队还没有专职平台工程时。
- **生产必须接 Postgres**，否则虚拟 Key、预算、花费都只在内存里。
- **路由策略按场景选**，不要默认 `simple-shuffle` 就上线。
- **回退要区分「同上下文窗口」与「更大窗口」**，否则长请求切过去还是失败。
- **多副本部署时 Redis 是必需的**，用于路由状态、缓存和限流。
- **需要深度定制（特殊鉴权、复杂计费、私有协议）时，自研或 fork 更划算。**

## 能直接用 vs 需要开发

| 能力 | LiteLLM 现状 | 建议 |
| --- | --- | --- |
| 多供应商接入 | 覆盖广，适配成熟 | 直接用 |
| OpenAI 兼容 API | 完整 | 直接用 |
| 虚拟 Key / 团队 / 预算 | 内置 | 直接用，接 Postgres |
| 路由与回退 | 内置多种策略 | 直接用，按场景配置 |
| 缓存 | 支持 Redis / 语义缓存 | 精确缓存可直接用 |
| 可观测 | OTel / Prometheus / Langfuse 等回调 | 直接用 |
| 自定义鉴权 | 有钩子，但扩展有限 | 视复杂度 |
| 特殊计费（阶梯、合同价） | 需自定义回调 | 二次开发 |
| 私有协议 / 非 HTTP 上游 | 不支持 | 自研适配层 |

## 部署形态

```bash
# 最简：pip
pip install "litellm[proxy]"
litellm --config config.yaml --port 4000

# Docker
docker run -d --name litellm \
  -p 4000:4000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -e LITELLM_MASTER_KEY=$MASTER_KEY \
  -e DATABASE_URL=$DATABASE_URL \
  ghcr.io/berriai/litellm:main-stable \
  --config /app/config.yaml
```

生产建议：

- 固定镜像 tag，不要用 `main`。
- 单独跑一个迁移容器执行 Prisma 迁移。
- 至少 2 副本，前面放支持 SSE 的反向代理。

## config.yaml 模板

```yaml
model_list:
  # ---------- OpenAI ----------
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o-2024-08-06
      api_key: os.environ/OPENAI_API_KEY
      rpm: 3000
      tpm: 2000000
      weight: 70
    model_info:
      mode: chat
      supports_function_calling: true
      supports_vision: true
      max_input_tokens: 128000

  - model_name: gpt-4o-mini
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY
      rpm: 6000
      weight: 100
    model_info:
      supports_function_calling: true
      max_input_tokens: 128000

  # ---------- Anthropic ----------
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: os.environ/ANTHROPIC_API_KEY
      rpm: 1000
      weight: 30
    model_info:
      supports_function_calling: true
      supports_vision: true
      max_input_tokens: 200000

  # ---------- 国内模型 ----------
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      rpm: 2000
      weight: 0        # 仅作回退
    model_info:
      supports_function_calling: true
      max_input_tokens: 64000

  - model_name: qwen-max
    litellm_params:
      model: dashscope/qwen-max
      api_key: os.environ.DASHSCOPE_API_KEY
      rpm: 1000
      weight: 0
    model_info:
      supports_function_calling: true
      max_input_tokens: 32000

  # ---------- 自建 ----------
  - model_name: local-qwen
    litellm_params:
      model: openai/qwen2.5-72b-instruct
      api_base: http://vllm:8000/v1
      api_key: os.environ/LOCAL_KEY
      rpm: 500
    model_info:
      supports_function_calling: true
      max_input_tokens: 32000

router_settings:
  routing_strategy: usage-based-routing-v2
  num_retries: 2
  timeout: 120
  allowed_fails: 3
  cooldown_time: 30
  enable_pre_call_checks: true

  redis_host: os.environ/REDIS_HOST
  redis_port: 6379
  redis_password: os.environ/REDIS_PASSWORD

  fallbacks:
    - gpt-4o: ["claude-sonnet", "deepseek-chat"]
    - claude-sonnet: ["gpt-4o", "qwen-max"]
    - gpt-4o-mini: ["deepseek-chat"]

  context_window_fallbacks:
    - gpt-4o: ["claude-sonnet"]
    - deepseek-chat: ["claude-sonnet"]

litellm_settings:
  drop_params: true
  request_timeout: 120
  num_retries: 2
  cache: true
  cache_params:
    type: redis
    host: os.environ/REDIS_HOST
    port: 6379
    password: os.environ/REDIS_PASSWORD
    ttl: 3600
    supported_call_types: ["acompletion"]
  success_callback: ["prometheus", "otel"]
  failure_callback: ["prometheus", "otel"]
  max_budget: 5000
  budget_duration: 30d

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  store_model_in_db: true
  proxy_batch_write_at: 10
  alerting: ["slack"]
  alerting_threshold: 300
```

### 几个关键字段的解释

| 字段 | 作用 | 注意 |
| --- | --- | --- |
| `weight` | 同 `model_name` 下多个部署的分流权重 | 设为 0 表示只作回退 |
| `rpm` / `tpm` | 该部署的配额 | 用于预检查与限流 |
| `routing_strategy` | 选部署的算法 | 见下一节 |
| `num_retries` | 单次请求重试次数 | 会与业务侧重试叠加 |
| `allowed_fails` | 触发冷却的失败次数 | 太小会频繁熔断 |
| `cooldown_time` | 冷却秒数 | 上游恢复慢时调大 |
| `enable_pre_call_checks` | 转发前过滤不合适的部署 | 建议开启 |
| `drop_params` | 丢弃上游不支持的参数 | 避免 400，但会静默改变行为 |
| `context_window_fallbacks` | 上下文超限时的回退 | 与普通 fallback 分开 |

::: warning `drop_params: true` 的两面性
它能避免大量「这个参数不支持」的 400，但也会**静默丢弃**你依赖的参数（如 `response_format`）。开启后要在测试里覆盖关键参数，确认行为符合预期。
:::

## 路由策略怎么选

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| `simple-shuffle` | 按权重随机 | 部署同质、追求简单 |
| `least-busy` | 选当前并发最低 | 请求时长差异大 |
| `usage-based-routing-v2` | 按 TPM/RPM 余量选 | 有明确配额上限 |
| `latency-based-routing` | 选历史延迟最低 | 体验优先 |

对流式长请求，`least-busy` 或 `usage-based-routing-v2` 通常比随机更稳，因为随机容易把多个长请求堆到同一个部署上。

## 虚拟 Key 与预算

通过管理 API 创建租户与 Key：

```bash
curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "models": ["gpt-4o-mini", "deepseek-chat"],
    "max_budget": 200,
    "budget_duration": "30d",
    "rpm_limit": 300,
    "tpm_limit": 600000,
    "team_id": "team_support",
    "metadata": {"tenant": "t_1001"}
  }'
```

返回的 Key 可以像普通 OpenAI Key 一样使用。预算耗尽后请求会被拒绝，花费数据写在你配置的 Postgres 里。

几个实践点：

- **`master_key` 只用于管理**，不要发给业务。
- **按团队/租户设预算**，不要只设全局。
- **定期对账**：LiteLLM 的花费表和供应商账单比一比。
- **Key 的 `metadata` 可以带租户信息**，便于日志归因。

## 回退配置的坑

```yaml
fallbacks:
  - gpt-4o: ["claude-sonnet", "deepseek-chat"]
```

这段配置的含义是「gpt-4o 失败时依次尝试」。但要注意：

1. **能力不对等**：`deepseek-chat` 上下文更小，长请求切过去仍然失败。用 `context_window_fallbacks` 单独处理。
2. **工具调用**：回退目标必须支持 tools，否则工具类请求会失败。
3. **无限回退**：A → B → A 的环会导致请求被反复重试。配置时避免成环。
4. **计费归属**：回退后的调用按实际模型计费，但业务可能按原模型定价收费，中间差价要能算清。

## 可观测

LiteLLM 支持多种回调。生产最小组合：

```yaml
litellm_settings:
  success_callback: ["prometheus", "otel"]
  failure_callback: ["prometheus", "otel"]
```

- `prometheus`：暴露 `/metrics`，抓取请求数、延迟、花费。
- `otel`：导出 span，接 Tempo/Jaeger。
- 需要按次查看 prompt/response 时再加 Langfuse 等，但要注意数据合规。

回调是**同步还是异步**要看实现。高频场景下建议用异步/批量写入，避免回调拖慢主路径。

## 多副本注意事项

| 项 | 要求 |
| --- | --- |
| Postgres | 所有副本共享，存放 Key/预算/花费 |
| Redis | 共享路由状态、缓存、限流 |
| 迁移 | 只由一个任务执行，避免并发迁移 |
| 配置 | 每个副本同一份，变更后滚动重启或热加载 |
| 时钟 | NTP 同步，否则预算窗口错位 |
| 会话 | 不依赖本地内存 |

LiteLLM 的花费写入有批量延迟（`proxy_batch_write_at`），多副本下预算可能短暂超支。对预算极敏感的场景要调小批量窗口，或在外层再加一道预算检查。

## 二次开发的入口

| 需求 | 方式 |
| --- | --- |
| 自定义日志字段 | CustomLogger 回调 |
| 自定义路由 | 自定义 Router 或前置服务 |
| 特殊鉴权 | 自定义 auth hook |
| 请求/响应改写 | guardrail / callback |
| 私有供应商 | 自定义 provider 适配 |

如果改动超过三处，建议重新评估：是继续 fork，还是把 LiteLLM 当作上游、自己在前面加一层轻量网关。Fork 的长期成本（合并冲突、升级滞后）经常被低估。

## 自研 vs LiteLLM

| 维度 | LiteLLM | 自研 |
| --- | --- | --- |
| 上线速度 | 天 | 周–月 |
| 供应商覆盖 | 广 | 按需 |
| 定制能力 | 中等 | 高 |
| 性能调优 | 受框架约束 | 完全可控 |
| 升级风险 | 跟随上游 | 自己负责 |
| 特殊计费 | 需开发 | 原生 |
| 团队成本 | 低 | 高 |

判断标准：**如果你的核心差异化在「模型接入的广度和速度」，用 LiteLLM；如果在于「计费、隔离、协议、性能」，自研或混合更合适。**

混合方案也很常见：LiteLLM 作为上游适配层，自研网关在前面做鉴权、配额、计费和路由决策。

## 迁移路径

从直连迁到 LiteLLM：

1. 用同一批模型名建 `model_list`。
2. 业务只改 `base_url` 和 Key。
3. 打开日志，对比两边的 token 与成本。
4. 逐步启用回退、缓存、预算。
5. 观察一周后再下线直连。

不要一次性把所有流量切过去。先切一个非核心业务，验证计费与流式都正常。

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 不接 Postgres | Key/预算重启即丢 |
| 用 `main` 镜像 | 随时可能引入不兼容变更 |
| `weight: 0` 却期望被随机选中 | 回退目标从不参与常规分流 |
| 回退链成环 | 请求被反复重试 |
| 只设全局预算 | 单个租户可以烧光全部额度 |
| 开 `drop_params` 不测试 | 关键参数被静默丢弃 |
| 多副本不共享 Redis | 路由与缓存状态不一致 |
| 回调同步写 | 高峰期拖慢主链路 |

## Checklist

- [ ] 固定镜像版本，独立执行迁移
- [ ] 接 Postgres，虚拟 Key 与花费持久化
- [ ] 多副本共享 Redis
- [ ] 路由策略按请求特征选择，而非默认随机
- [ ] 回退链能力对等、无环，长上下文单独配置
- [ ] 开启 `enable_pre_call_checks`
- [ ] 按团队/租户设预算，而非仅全局
- [ ] 关键参数在 `drop_params` 下经过测试
- [ ] 可观测回调异步化，数据合规
- [ ] 评估过自研/fork 的长期成本
- [ ] 迁移按业务逐步切换，先验证计费与流式

## 下一篇

最后一页看上层框架如何接入：[LangGraph / CrewAI / Dify 集成](./langgraph-crewai-dify.md)。
