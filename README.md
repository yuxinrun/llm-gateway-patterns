# LLM Gateway Patterns

大模型网关工程模式与实战手册。面向后端工程师、AI 平台开发者与自研 Agent 平台的团队，聚焦生产环境中的架构范式与最佳实践，而不是入门教程或接口文档。

站点地址：**https://yuxinrun.github.io/llm-gateway-patterns/**

## 这套手册讲什么

- **为什么需要网关**：直连模型的风险、成本与治理缺口。
- **基础开发模式**：最小 Python / TypeScript 网关、SSE 转发、OpenAI 兼容协议、超时与错误码。
- **生产级工程模式**：路由、缓存、限流、鉴权隔离、重试熔断、成本统计。
- **可观测体系**：结构化日志、链路追踪、指标、OpenTelemetry 与告警。
- **实战场景**：多厂商容灾、企业多租户、KV Cache 降本、Agent 与 MCP 集成。
- **调试与性能**：SSE 断流、长上下文、压测与瓶颈定位、常见故障手册。
- **部署运维**：Docker Compose、无状态扩展、安全加固、模型灰度。
- **生态集成**：LiteLLM 配置模板、LangGraph / CrewAI / Dify 接入。

## 三层技术栈

```text
better-agent（Agent 调度层）
        ↑
mcp-patterns（MCP 工具层）
        ↑
llm-gateway-patterns（模型网关层）  ← 本仓库
```

- [better-agent](https://yuxinrun.github.io/better-agent/)：构建更好的 Agent。
- [mcp-patterns](https://yuxinrun.github.io/mcp-patterns/)：MCP 工程模式。
- 三个站点互相导流，分别覆盖模型接入、工具调用与 Agent 编排。

## 技术栈

- [VitePress](https://vitepress.dev/) 1.x，Markdown 驱动，静态生成。
- Mermaid 图表（`vitepress-plugin-mermaid`）。
- 中英双语、明暗主题、本地搜索、移动端适配。
- GitHub Actions 自动部署到 GitHub Pages。

## 本地开发

要求 Node.js 20+。

```bash
npm install
npm run dev      # http://localhost:5173/llm-gateway-patterns/
npm run build    # 输出到 docs/.vitepress/dist
npm run preview  # 预览构建结果
```

## 目录结构

```text
docs/
├── .vitepress/
│   ├── config.mts              # 站点、语言、主题配置
│   ├── config/navigation.mts   # 导航与侧边栏
│   ├── data/chapters.ts        # 章节元数据（首页与侧边栏共用）
│   └── theme/                  # 自定义主题与首页组件
├── 00-introduction/            # 开篇：定位、架构、选型、能力清单
├── 01-basics/                  # 基础：最小网关、SSE、协议、错误
├── 02-production/              # 生产：路由、缓存、限流、鉴权、容错、成本
├── 03-observability/           # 可观测：日志、指标、OTel、告警
├── 04-scenarios/               # 实战：容灾、多租户、KV Cache、生态
├── 05-debugging/               # 排障：SSE、长上下文、压测、急救
├── 06-deploy/                  # 部署：Compose、扩展、安全、灰度
├── 07-ecosystem/               # 生态：LiteLLM、Agent 框架
├── en/                         # 英文镜像
├── public/                     # logo 与 hero 图
└── index.md                    # 中文首页
```

## 部署

推送到 `main` 后，`.github/workflows/deploy.yml` 会自动构建并发布到 GitHub Pages。

首次部署前，在仓库 **Settings → Pages → Build and deployment** 中把 Source 设为 **GitHub Actions**。

VitePress 的 `base` 已配置为 `/llm-gateway-patterns/`，对应组织项目仓库的访问路径。

## 写作约定

- 每页先给结论，再讲原因与实现。
- 代码示例保持可运行，优先完整片段而非伪代码。
- 区分「最小可用」与「生产必需」，明确生产缺口。
- 图表只用于表达结构与时序，不做装饰。
- 涉及厂商行为时标注「以官方文档为准」。

## 贡献

欢迎提交 Issue 与 Pull Request。新增页面时：

1. 在 `docs/.vitepress/data/chapters.ts` 注册中英文条目。
2. 同步创建 `docs/` 与 `docs/en/` 下的对应文件。
3. 确保 `npm run build` 通过（默认开启死链检查）。

## License

[MIT](./LICENSE) © 2026 yuxinrun
