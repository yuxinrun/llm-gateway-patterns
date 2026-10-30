---
layout: home

hero:
  name: LLM Gateway Patterns
  text: 大模型网关工程模式与实战手册
  tagline: 把「能调通模型 API」升级成「能在生产扛住流量、成本与故障」。写给后端工程师、AI 平台与自研 Agent 团队。
  image:
    light: /hero-light.svg
    dark: /hero-dark.svg
    alt: 应用与 Agent 通过 LLM 网关访问 OpenAI、Claude、Gemini 等模型
  actions:
    - theme: brand
      text: 从开篇读起
      link: /00-introduction/why-gateway
    - theme: alt
      text: 跑通最小网关
      link: /01-basics/minimal-python
    - theme: alt
      text: GitHub
      link: https://github.com/yuxinrun/llm-gateway-patterns

features:
  - title: 模式优先，不堆接口文档
    details: 从路由、缓存、限流到容错，每个模式都写清适用场景、反模式和落地清单，而不是重复官方参数表。
    link: /02-production/routing
    linkText: 看生产模式
  - title: Python + TypeScript 双 Demo
    details: 两个最小网关都能在百行左右跑通流式代理，先看见效果，再按业务逐步加能力。
    link: /01-basics/minimal-python
    linkText: 跑最小网关
  - title: 生产视角的故障清单
    details: SSE 断流、429、缓存污染、长上下文、灰度回滚，都有现场排查路径和处置顺序。
    link: /05-debugging/common-issues
    linkText: 打开急救手册
  - title: 成本与缓存一起讲
    details: token 计费、租户账单、Prompt/KV Cache 命中率和预算预警，算得清才敢放量。
    link: /02-production/cost
    linkText: 算清成本
  - title: 可观测闭环
    details: TraceId 从上游 Agent 贯穿到模型调用，OpenTelemetry、Prometheus 与告警规则成套给出。
    link: /03-observability/metrics
    linkText: 建好看板
  - title: 与 Agent / MCP 打通
    details: 和 better-agent、mcp-patterns 组成完整技术栈，网关不只是反向代理，而是模型治理边界。
    link: /04-scenarios/better-agent
    linkText: 看生态对接
---

<HomeEcosystem />

<HomeChapters />

## 先看结论

> **网关不是“多一层代理”，而是把模型的不确定性关进一个可运营的边界。**
>
> 统一协议、隔离密钥、控制成本、兜住故障——四件事只要有一件让你痛，就值得读下去。

### 三种读法

| 你的处境 | 从这里开始 | 你会拿到 |
| --- | --- | --- |
| 刚接第一个模型，想少踩坑 | [最小可用网关](./01-basics/minimal-python.md) | 百行可运行代理、SSE 透传、统一错误 |
| 已在生产调用，偶发超时 / 429 | [重试、熔断与兜底](./02-production/resilience.md) | 可重试判定、熔断状态机、兜底链 |
| 多团队共用一套模型预算 | [企业多租户](./04-scenarios/multi-tenant.md) | 租户配额、密钥隔离、账单拆分 |
| 正在做 Agent 平台 | [对接 better-agent](./04-scenarios/better-agent.md) | 模型别名、成本归因、链路追踪 |

### 内容约定

- Demo 默认使用 **Python 3.11+ / FastAPI / httpx**；TypeScript 使用 **Node.js 20+ / Hono**。
- 代码优先“能跑、能改”，不追求大而全；上线前请对照每篇末尾的检查清单补齐。
- 涉及价格、限流额度的数字只用于演示计算方法，请以厂商当期价格与条款为准。
- 文中厂商名与接口路径仅用于技术说明，不构成选型或采购建议。

### 这个站点不做什么

不替代官方 API 文档，不教你写第一个 prompt，也不追求“支持所有模型”。它只回答一个问题：**当模型调用要进入生产，工程上该补齐什么。**
