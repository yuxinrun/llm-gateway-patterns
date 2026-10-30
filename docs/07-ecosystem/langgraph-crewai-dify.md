---
title: LangGraph / CrewAI / Dify 集成
description: 三个主流框架接入自建网关的配置方式、模型名约定、流式与工具调用差异，以及常见故障。
---

# LangGraph / CrewAI / Dify 集成

这三类框架覆盖了大多数上层场景：LangGraph 做可控的图编排，CrewAI 做角色协作，Dify 做低代码应用。它们都支持 OpenAI 兼容接口，所以接自建网关的原理一样——**改 `base_url` 和 `api_key`，再对上模型名**。

难点在于每个框架对「模型名」的解析方式不同，以及工具调用、流式、用量回传的实现细节不一致。

## 先说结论

- **统一走 OpenAI 兼容入口**，不要让框架直连各家 SDK。
- **模型名要区分「框架前缀」与「网关别名」**：`openai/xxx` 里的 `xxx` 才是网关看到的模型。
- **工具调用是最大的兼容点**，框架生成的 schema 可能包含网关上游不支持的字段。
- **流式要验证到最后一个 chunk**，包括 usage 与 `[DONE]`。
- **用量归因靠请求头**，多数框架支持自定义 header，把 `run_id`/`tenant` 透传下去。

## 通用接入清单

| 项 | 配置 |
| --- | --- |
| Base URL | `https://gateway.example.com/v1` |
| API Key | 网关签发的租户 Key |
| 模型名 | 网关的别名，如 `chat-default` |
| 流式 | 确认框架与网关都开启 |
| 工具调用 | 确认目标模型支持，schema 兼容 |
| 超时 | 大于最长流式时长 |
| 重试 | 框架侧重试要关闭或设为 0 |
| 请求头 | `X-Run-Id`、`X-Feature` 等 |

::: warning base_url 的 `/v1`
OpenAI SDK 会在 `base_url` 后拼接 `/chat/completions`。如果你写 `https://gateway.example.com`，实际请求会变成 `https://gateway.example.com/chat/completions`，少了 `/v1`。统一写成 `https://gateway.example.com/v1`。
:::

## LangGraph

LangGraph 本身不绑定模型，模型来自 LangChain 的 chat model。接网关就是配置 `ChatOpenAI`：

```python
import os

from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, MessagesState, START, END


def make_model(step: str) -> ChatOpenAI:
    return ChatOpenAI(
        model="chat-default",
        base_url="https://gateway.example.com/v1",
        api_key=os.environ["LGW_API_KEY"],
        timeout=120,
        max_retries=0,
        default_headers={
            "X-Feature": "langgraph-demo",
            "X-Step-Type": step,
        },
        stream_usage=True,
    )
```

`max_retries=0` 很重要：让网关负责上游重试，避免两层叠加。

### 按节点用不同模型

```python
planner = make_model("plan")
executor = make_model("act")


def plan_node(state: MessagesState):
    resp = planner.invoke([
        {"role": "system", "content": "把任务拆成步骤，输出 JSON。"},
        *state["messages"],
    ])
    return {"messages": [resp]}


def act_node(state: MessagesState):
    resp = executor.invoke(state["messages"])
    return {"messages": [resp]}


builder = StateGraph(MessagesState)
builder.add_node("plan", plan_node)
builder.add_node("act", act_node)
builder.add_edge(START, "plan")
builder.add_edge("plan", "act")
builder.add_edge("act", END)
graph = builder.compile()
```

如果想让网关决定用哪个模型，就统一传 `model="agent-default"`，靠 `X-Step-Type` 路由。两种方式都行，**关键是别在框架里写死具体供应商**。

### 流式

```python
async for event in graph.astream_events(
    {"messages": [{"role": "user", "content": "调研一下向量数据库"}]},
    version="v2",
):
    if event["event"] == "on_chat_model_stream":
        chunk = event["data"]["chunk"]
        if chunk.content:
            print(chunk.content, end="", flush=True)
```

LangGraph 的事件流会包含多个节点的输出。网关侧看到的是多次独立的模型调用，归因时要用 `run_id` 把它们串起来。

### 工具调用

LangChain 的 `bind_tools` 会生成 JSON Schema。如果上游对 schema 支持有限，先简化：

```python
from pydantic import BaseModel, Field


class SearchInput(BaseModel):
    query: str = Field(description="搜索关键词，尽量简短")
    top_k: int = Field(default=5, ge=1, le=20)


tools = [{
    "type": "function",
    "function": {
        "name": "search",
        "description": "搜索知识库",
        "parameters": SearchInput.model_json_schema(),
    },
}]

model_with_tools = executor.bind_tools(tools)
```

避免使用 `$ref`、复杂的 `oneOf`、递归结构——部分供应商不支持。

## CrewAI

CrewAI 底层用 LiteLLM 解析模型名，所以格式是 `<provider>/<model>`。接自建网关时，provider 写 `openai`，后面跟网关别名：

```python
import os

from crewai import Agent, Crew, LLM, Task

gateway = LLM(
    model="openai/chat-default",
    base_url="https://gateway.example.com/v1",
    api_key=os.environ["LGW_API_KEY"],
    temperature=0.3,
    timeout=120,
)

researcher = Agent(
    role="研究员",
    goal="找到可靠的资料并总结",
    backstory="你擅长从多个来源交叉验证信息。",
    llm=gateway,
    verbose=True,
)

writer = Agent(
    role="撰稿人",
    goal="把研究结果写成清晰的报告",
    backstory="你只使用研究员提供的事实。",
    llm=gateway,
)

research = Task(
    description="调研 LLM 网关的常见路由策略",
    expected_output="包含至少 3 种策略的对比",
    agent=researcher,
)

write = Task(
    description="基于研究结果写一份 500 字报告",
    expected_output="结构清晰的中文报告",
    agent=writer,
)

crew = Crew(agents=[researcher, writer], tasks=[research, write])
result = crew.kickoff()
```

几个坑：

- **`model` 必须带 `openai/` 前缀**，否则 LiteLLM 可能按其他 provider 解析。
- **`base_url` 不要重复 `/v1`**，CrewAI 会自己拼。
- **工具调用**：CrewAI 的工具体系会生成较复杂的 schema，遇到 400 时先减少工具数量或简化参数。
- **重试**：CrewAI/LiteLLM 有自己的重试，和网关叠加时要调小。

## Dify

Dify 通过「OpenAI-API-compatible」模型供应商接入自建网关，在「设置 → 模型供应商」里配置：

| 字段 | 值 |
| --- | --- |
| Base URL | `https://gateway.example.com/v1` |
| API Key | 租户 Key |
| Model Name | `chat-default` |
| Function Calling | 按模型能力选择 |
| Streaming | 开启 |
| Context Size | 按模型填写 |

如果是自托管 Dify，也可以用环境变量预置：

```yaml
# docker-compose 中 dify-api 的环境变量片段
OPENAI_API_BASE: https://gateway.example.com/v1
OPENAI_API_KEY: ${LGW_API_KEY}
```

注意 Dify 的模型配置界面要求 **Base URL 通常以 `/v1` 结尾**，而部分版本会自动补 `/v1`，配置后先用「测试连接」验证，避免出现 `/v1/v1`。

### Dify 的两个注意点

1. **Function Calling 能力**：Dify 会根据模型配置决定是否启用工具调用。如果网关路由到的实际模型不支持 tools，Agent 节点会失败。要么在网关侧按能力路由，要么在 Dify 里只绑定支持工具的模型。
2. **用量回传**：Dify 的工作流会统计 token，但它依赖上游返回的 usage。开启 `stream_options.include_usage`，否则统计为空。

## 对比

| 维度 | LangGraph | CrewAI | Dify |
| --- | --- | --- | --- |
| 接入方式 | LangChain ChatModel | LiteLLM 风格 | 模型供应商插件 |
| 模型名 | 网关别名 | `openai/<别名>` | 网关别名 |
| 自定义 header | 支持 | 部分支持 | 有限 |
| 流式 | 事件流，粒度细 | 支持 | 支持 |
| 工具调用 | 自定义 schema | 自动生成，较复杂 | 可视化配置 |
| 多模型路由 | 代码里指定 | 每 Agent 指定 | 每个节点指定 |
| 适合 | 复杂可控编排 | 角色协作 | 低代码应用 |

## 请求头与归因

框架层的 `run_id` 要传到网关，才能做任务级成本归因。

**LangGraph / LangChain**：

```python
model = ChatOpenAI(
    model="chat-default",
    base_url="...",
    api_key="...",
    default_headers={"X-Run-Id": run_id, "X-Feature": "research"},
)
```

**CrewAI**：通过 `LLM(extra_headers=...)` 或全局环境变量传递，具体字段随版本变化，建议在网关侧同时支持从请求体 `metadata` 中提取。

**Dify**：自定义 header 支持有限，通常只能按应用配置固定值。如果必须按请求归因，在网关侧用 Key 区分应用。

## 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 404 | 模型名带了 provider 前缀但网关不认 | 网关侧支持别名，或去掉前缀 |
| 404 且路径是 `/v1/v1/...` | base_url 重复 | 只保留一个 `/v1` |
| 400 tool schema | schema 含不支持字段 | 简化，去掉 `$ref`/`oneOf` |
| 工具调用变文本 | 目标模型不支持 tools | 按能力路由 |
| 流式中断 | 代理缓冲/超时 | 检查网关与代理配置 |
| usage 为空 | 未开 `include_usage` | 框架或网关层开启 |
| 重复计费 | 框架与网关都重试 | 框架侧 `max_retries=0` |
| 首字很慢 | 框架先做其他节点 | 看 trace，区分框架耗时与模型耗时 |

## 选型建议

- **需要精确控制每一步、做条件分支与人工介入**：LangGraph。
- **快速搭一个多角色协作流程**：CrewAI。
- **业务同学要自己搭应用、少写代码**：Dify。
- **三者可以共存**：它们都只是网关的客户端，网关不需要为框架做特殊适配。

真正需要统一的是：模型别名、请求头约定、计费口径。这三样定好，上层换框架不影响平台。

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 每个框架直连不同供应商 | 适配与计费分散 |
| 模型名写死供应商型号 | 换模型要改业务代码 |
| 框架与网关双重试 | 流量放大、重复计费 |
| base_url 少写或多写 `/v1` | 404 |
| 不传 `run_id` | 无法按任务归因 |
| 忽略工具 schema 兼容性 | 工具调用随机失败 |
| 不验证流式最后一包 | 丢失 usage 与结束原因 |

## Checklist

- [ ] 三个框架都指向同一个网关入口
- [ ] `base_url` 统一以 `/v1` 结尾
- [ ] 模型名使用网关别名，不写供应商型号
- [ ] 框架侧重试关闭或调小
- [ ] 工具 schema 已在目标模型上验证
- [ ] 流式包含 usage 与结束标记
- [ ] `run_id`/`feature` 通过 header 或 Key 归因
- [ ] 超时覆盖最长流式时长
- [ ] 常见 404/400 有排查路径

---

到这里，主线章节就结束了。建议回到[开篇](../00-introduction/why-gateway.md)对照能力清单做一次自查，或者直接看[配套项目 better-agent](https://yuxinrun.github.io/better-agent/) 与 [mcp-patterns](https://yuxinrun.github.io/mcp-patterns/)，把三层串起来。
