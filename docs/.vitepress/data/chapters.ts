export interface ChapterItem {
  text: string
  link: string
}

export interface Chapter {
  id: string
  num: string
  title: string
  blurb: string
  items: ChapterItem[]
}

export const chaptersZh: Chapter[] = [
  {
    id: '00-introduction',
    num: '00',
    title: '开篇',
    blurb: '先建立判断：什么时候该上网关，它到底解决什么问题。',
    items: [
      { text: '为什么需要 LLM 网关', link: '/00-introduction/why-gateway' },
      { text: '网关在 AI 架构中的位置', link: '/00-introduction/architecture' },
      { text: '开源网关对比与选型', link: '/00-introduction/comparison' },
      { text: '网关核心能力清单', link: '/00-introduction/capabilities' }
    ]
  },
  {
    id: '01-basics',
    num: '01',
    title: '基础开发模式',
    blurb: '从 100 行代码开始，跑通代理、流式转发与统一协议。',
    items: [
      { text: '最小可用网关（Python）', link: '/01-basics/minimal-python' },
      { text: 'TS 最小网关与 SSE 转发', link: '/01-basics/minimal-ts-sse' },
      { text: '统一协议：对齐 OpenAI', link: '/01-basics/openai-compat' },
      { text: '超时、异常与错误码', link: '/01-basics/errors-timeout' }
    ]
  },
  {
    id: '02-production',
    num: '02',
    title: '生产级工程模式',
    blurb: '路由、缓存、限流、鉴权、容错、成本——六块生产积木。',
    items: [
      { text: '路由模式：权重、标签与切流', link: '/02-production/routing' },
      { text: '缓存模式：结果、KV 与击穿防护', link: '/02-production/caching' },
      { text: '限流与配额：RPM/TPM 分级', link: '/02-production/rate-limit' },
      { text: '鉴权隔离与多租户', link: '/02-production/auth-tenant' },
      { text: '重试、熔断、降级与兜底', link: '/02-production/resilience' },
      { text: '成本统计与预算预警', link: '/02-production/cost' }
    ]
  },
  {
    id: '03-observability',
    num: '03',
    title: '可观测体系',
    blurb: '让每一次调用可追踪、可度量、可告警。',
    items: [
      { text: '结构化日志与 TraceId', link: '/03-observability/logging-tracing' },
      { text: '核心指标与看板', link: '/03-observability/metrics' },
      { text: 'OpenTelemetry 与告警', link: '/03-observability/otel-alerting' }
    ]
  },
  {
    id: '04-scenarios',
    num: '04',
    title: '实战场景',
    blurb: '把模式放进真实业务：容灾、多租户、KV Cache、生态对接。',
    items: [
      { text: '多厂商混合接入与容灾', link: '/04-scenarios/multi-vendor-failover' },
      { text: '企业多租户配额管控', link: '/04-scenarios/multi-tenant' },
      { text: 'KV Cache 代理与成本优化', link: '/04-scenarios/kv-cache' },
      { text: '对接 better-agent', link: '/04-scenarios/better-agent' },
      { text: '对接 mcp-patterns', link: '/04-scenarios/mcp-patterns' }
    ]
  },
  {
    id: '05-debugging',
    num: '05',
    title: '调试排坑与性能',
    blurb: 'SSE 断流、长上下文、压测、429：现场排障手册。',
    items: [
      { text: 'SSE 断连与分片异常', link: '/05-debugging/sse-issues' },
      { text: '超长上下文请求', link: '/05-debugging/long-context' },
      { text: '并发压测与瓶颈定位', link: '/05-debugging/load-testing' },
      { text: '高频问题急救手册', link: '/05-debugging/common-issues' }
    ]
  },
  {
    id: '06-deploy',
    num: '06',
    title: '部署与运维',
    blurb: 'Compose 起步，无状态扩展，安全加固，灰度发布。',
    items: [
      { text: 'Docker Compose 部署', link: '/06-deploy/docker-compose' },
      { text: '无状态水平扩展', link: '/06-deploy/scaling' },
      { text: '安全加固与密钥保护', link: '/06-deploy/security' },
      { text: '灰度切换模型版本', link: '/06-deploy/canary' }
    ]
  },
  {
    id: '07-ecosystem',
    num: '07',
    title: '生态集成',
    blurb: 'LiteLLM 模板与主流 Agent 框架接入。',
    items: [
      { text: 'LiteLLM 高阶配置模板', link: '/07-ecosystem/litellm' },
      { text: 'LangGraph / CrewAI / Dify 接入', link: '/07-ecosystem/langgraph-crewai-dify' }
    ]
  }
]

export const chaptersEn: Chapter[] = [
  {
    id: '00-introduction',
    num: '00',
    title: 'Introduction',
    blurb: 'Build the judgment first: when you need a gateway, and what it really solves.',
    items: [
      { text: 'Why an LLM Gateway', link: '/en/00-introduction/why-gateway' },
      { text: 'Where the Gateway Sits', link: '/en/00-introduction/architecture' },
      { text: 'Open-Source Gateways Compared', link: '/en/00-introduction/comparison' },
      { text: 'Gateway Capability Checklist', link: '/en/00-introduction/capabilities' }
    ]
  },
  {
    id: '01-basics',
    num: '01',
    title: 'Fundamentals',
    blurb: 'Start with about 100 lines: proxying, streaming, and one unified API.',
    items: [
      { text: 'Minimal Gateway in Python', link: '/en/01-basics/minimal-python' },
      { text: 'TypeScript Gateway & SSE', link: '/en/01-basics/minimal-ts-sse' },
      { text: 'One API: OpenAI-Compatible', link: '/en/01-basics/openai-compat' },
      { text: 'Timeouts, Exceptions & Errors', link: '/en/01-basics/errors-timeout' }
    ]
  },
  {
    id: '02-production',
    num: '02',
    title: 'Production Patterns',
    blurb: 'Routing, caching, rate limits, auth, resilience, cost: six building blocks.',
    items: [
      { text: 'Routing: Weights, Tags & Failover', link: '/en/02-production/routing' },
      { text: 'Caching: Results, KV & Stampedes', link: '/en/02-production/caching' },
      { text: 'Rate Limits & Quotas (RPM/TPM)', link: '/en/02-production/rate-limit' },
      { text: 'Auth & Tenant Isolation', link: '/en/02-production/auth-tenant' },
      { text: 'Retries, Breakers & Fallbacks', link: '/en/02-production/resilience' },
      { text: 'Cost Tracking & Budget Alerts', link: '/en/02-production/cost' }
    ]
  },
  {
    id: '03-observability',
    num: '03',
    title: 'Observability',
    blurb: 'Make every call traceable, measurable, and alertable.',
    items: [
      { text: 'Structured Logs & Trace IDs', link: '/en/03-observability/logging-tracing' },
      { text: 'Metrics & Dashboards', link: '/en/03-observability/metrics' },
      { text: 'OpenTelemetry & Alerting', link: '/en/03-observability/otel-alerting' }
    ]
  },
  {
    id: '04-scenarios',
    num: '04',
    title: 'In Practice',
    blurb: 'Patterns in real systems: failover, multi-tenancy, KV cache, ecosystem wiring.',
    items: [
      { text: 'Multi-Vendor Failover', link: '/en/04-scenarios/multi-vendor-failover' },
      { text: 'Enterprise Multi-Tenancy', link: '/en/04-scenarios/multi-tenant' },
      { text: 'KV Cache Proxy', link: '/en/04-scenarios/kv-cache' },
      { text: 'Wiring into better-agent', link: '/en/04-scenarios/better-agent' },
      { text: 'Wiring into mcp-patterns', link: '/en/04-scenarios/mcp-patterns' }
    ]
  },
  {
    id: '05-debugging',
    num: '05',
    title: 'Debugging & Performance',
    blurb: 'SSE drops, long context, load tests, 429s: a field troubleshooting guide.',
    items: [
      { text: 'SSE Drops & Chunking Bugs', link: '/en/05-debugging/sse-issues' },
      { text: 'Long-Context Requests', link: '/en/05-debugging/long-context' },
      { text: 'Load Testing & Bottlenecks', link: '/en/05-debugging/load-testing' },
      { text: 'Troubleshooting Playbook', link: '/en/05-debugging/common-issues' }
    ]
  },
  {
    id: '06-deploy',
    num: '06',
    title: 'Deployment & Ops',
    blurb: 'Compose first, then scale stateless, harden security, roll out canaries.',
    items: [
      { text: 'Docker Compose Deployment', link: '/en/06-deploy/docker-compose' },
      { text: 'Stateless Horizontal Scaling', link: '/en/06-deploy/scaling' },
      { text: 'Security & Secret Protection', link: '/en/06-deploy/security' },
      { text: 'Canary Model Rollouts', link: '/en/06-deploy/canary' }
    ]
  },
  {
    id: '07-ecosystem',
    num: '07',
    title: 'Ecosystem',
    blurb: 'LiteLLM recipes and integrations for popular agent frameworks.',
    items: [
      { text: 'LiteLLM Advanced Config', link: '/en/07-ecosystem/litellm' },
      { text: 'LangGraph / CrewAI / Dify', link: '/en/07-ecosystem/langgraph-crewai-dify' }
    ]
  }
]

export const companionZh = [
  { text: '配套：better-agent', link: 'https://yuxinrun.github.io/better-agent/' },
  { text: '配套：mcp-patterns', link: 'https://yuxinrun.github.io/mcp-patterns/' },
  { text: 'GitHub 仓库', link: 'https://github.com/yuxinrun/llm-gateway-patterns' }
]

export const companionEn = [
  { text: 'Companion: better-agent', link: 'https://yuxinrun.github.io/better-agent/' },
  { text: 'Companion: mcp-patterns', link: 'https://yuxinrun.github.io/mcp-patterns/' },
  { text: 'GitHub Repository', link: 'https://github.com/yuxinrun/llm-gateway-patterns' }
]
