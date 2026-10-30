---
title: TS 最小网关与 SSE 转发
description: 用 Hono 写 TypeScript 最小网关，并正确处理 SSE 分片、背压与断连。
---

# TS 最小网关与 SSE 转发

Node.js 团队常常卡在同一个地方：Python 版能跑，但 SSE 一到 Node 就「有时完整、有时断」。原因通常不是网关，而是**把网络分片当成了 SSE 事件**。

这一篇写一个 TypeScript 最小网关，再把 SSE 解析讲透。

## 项目初始化

```bash
mkdir ts-gateway && cd ts-gateway
npm init -y
npm pkg set type=module
npm i hono @hono/node-server
npm i -D tsx typescript
```

目录：

```text
ts-gateway/
├── src/
│   ├── gateway.ts   # 网关
│   └── sse.ts       # SSE 解析器
└── package.json
```

## 网关代码

`src/gateway.ts`：

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'

const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY ?? ''
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? 'gpt-4o-mini'
const PORT = Number(process.env.PORT ?? 8787)

const app = new Hono()

function errorBody(code: string, message: string, requestId: string) {
  return {
    error: {
      message,
      type: 'gateway_error',
      code,
      request_id: requestId
    }
  }
}

function sseError(code: string, message: string, requestId: string) {
  const payload = JSON.stringify({ error: { code, message, request_id: requestId } })
  return `event: error\ndata: ${payload}\n\n`
}

app.get('/healthz', (c) => c.json({ status: 'ok' }))

app.post('/v1/chat/completions', async (c) => {
  const requestId = (c.req.header('x-request-id') ?? '').trim().slice(0, 128) || `req_${crypto.randomUUID().slice(0, 16)}`

  if (!UPSTREAM_API_KEY) {
    return c.json(errorBody('gateway_misconfigured', 'UPSTREAM_API_KEY is not set.', requestId), 500)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json(errorBody('invalid_json', 'Request body must be valid JSON.', requestId), 400)
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json(errorBody('invalid_messages', '`messages` must be a non-empty array.', requestId), 400)
  }

  body.model ??= DEFAULT_MODEL
  const isStream = body.stream === true

  let upstream: Response
  try {
    upstream = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
        'content-type': 'application/json',
        'x-request-id': requestId
      },
      body: JSON.stringify(body),
      // 演示用总上限；生产环境请改成「首字节超时 + 空闲超时 + 总预算」
      signal: AbortSignal.timeout(isStream ? 600_000 : 60_000)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json(errorBody('upstream_unreachable', message, requestId), 502)
  }

  if (!upstream.ok) {
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-request-id': requestId,
        'x-upstream-status': String(upstream.status)
      }
    })
  }

  if (!isStream) {
    const data = await upstream.text()
    return new Response(data, {
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId
      }
    })
  }

  c.header('content-type', 'text/event-stream; charset=utf-8')
  c.header('cache-control', 'no-cache, no-transform')
  c.header('x-accel-buffering', 'no')
  c.header('x-request-id', requestId)

  return stream(c, async (s) => {
    const reader = upstream.body?.getReader()
    if (!reader) {
      await s.write(sseError('upstream_empty_body', 'Upstream returned an empty body.', requestId))
      return
    }

    // 客户端断开时取消上游读取，尽快释放连接
    s.onAbort(() => {
      void reader.cancel().catch(() => undefined)
    })

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) await s.write(value)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await s.write(sseError('upstream_stream_error', message, requestId))
    } finally {
      reader.releaseLock()
      s.close()
    }
  })
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`gateway listening on http://127.0.0.1:${info.port}`)
})
```

运行：

```bash
export UPSTREAM_BASE_URL="https://api.deepseek.com/v1"
export UPSTREAM_API_KEY="sk-你的真实密钥"
export DEFAULT_MODEL="deepseek-chat"
npx tsx src/gateway.ts
```

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"用三句话介绍 SSE"}]}'
```

## SSE 到底有几层

这是理解所有「流式玄学」的关键。一次网络读取和一条 SSE 事件之间，**没有一一对应关系**。

```text
┌─────────────────────────────────────────────────────┐
│ 1. TCP / HTTP chunk：任意长度，可能半个事件          │
├─────────────────────────────────────────────────────┤
│ 2. SSE event：两条换行分隔，可含多行 data            │
├─────────────────────────────────────────────────────┤
│ 3. Model delta：JSON 里的 choices[0].delta.content   │
└─────────────────────────────────────────────────────┘
```

一个事件长这样：

```text
event: message
data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"你"}}]}

```

规则：

- 空行（`\n\n`）才是一个事件的结束。
- 以 `:` 开头的是注释，常用作心跳。
- 一个事件可以有多行 `data:`，按 `\n` 拼接。
- `data: [DONE]` 是 OpenAI 的约定，不是 SSE 标准。
- 不能假设「一次 `reader.read()` = 一个完整 JSON」。

## 客户端解析器

`src/sse.ts`：

```ts
export interface SSEEvent {
  event: string
  data: string
  id?: string
}

export async function* parseSSE(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) throw new Error('Response has no body')

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += value
      buffer = buffer.replace(/\r\n/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseEvent(raw)
        if (event) yield event
        boundary = buffer.indexOf('\n\n')
      }
    }

    if (buffer.trim()) {
      const event = parseEvent(buffer)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

function parseEvent(raw: string): SSEEvent | null {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }

  return data.length > 0 ? { event, data: data.join('\n'), id } : null
}
```

使用：

```ts
const res = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-chat',
    stream: true,
    messages: [{ role: 'user', content: '数到 10' }]
  })
})

if (!res.ok) throw new Error(await res.text())

for await (const event of parseSSE(res)) {
  if (event.data === '[DONE]') break
  if (event.event === 'error') {
    console.error('stream error:', event.data)
    break
  }

  const chunk = JSON.parse(event.data)
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? '')
}
```

::: tip 浏览器里为什么不用 `EventSource`
`EventSource` 只能发 GET，不能带自定义请求头，也没法提交 JSON 请求体。聊天场景请用 `fetch` + `ReadableStream`，解析逻辑与上面一致。
:::

## 三个设计要点

### 1. 逐块转发，不要攒完再发

```ts
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  if (value) await s.write(value)
}
```

如果先 `await upstream.text()` 再返回，流式就退化成了非流式：用户等完整答案，TTFT 直接等于总时长。

### 2. 背压要靠 `await` 传递

`await s.write(value)` 不只是「写出去」，它还会在消费端跟不上时施加背压。不要把它改成「收集到数组里稍后统一写」，那会把内存交给一个不可控的下游。

### 3. 断连要取消上游

`s.onAbort()` 里取消 `reader`，让上游连接尽快释放。否则用户关掉页面后，模型还在生成，token 还在计费。

::: warning Node 适配器的细节
不同部署方式（Node server、Serverless、Edge）对 `onAbort` 和 `Request.signal` 的支持不完全一致。上线前用真实客户端做一次「中途关闭页面」测试，确认上游请求确实被取消。
:::

## 和 Python 版的差异

| 维度 | Python（httpx） | TypeScript（fetch / Hono） |
| --- | --- | --- |
| 超时 | 四元组可分别配置 | 原生只有总超时，需自己实现空闲超时 |
| 解压 | `aiter_bytes()` 自动解压 | `fetch` 自动解压 |
| 断连 | 生成器取消 + `finally` | `stream.onAbort` + `reader.cancel` |
| 连接池 | `httpx.AsyncClient` | undici 全局调度器，可用 Agent 调整 |
| 状态码 | 先 `send` 再决定响应 | 先 `fetch` 再决定响应 |

## 常见坑

::: danger 按 `\n` 切 JSON
网络分片可能在任意字节处断开。必须按空行切事件，再按 `data:` 聚合。
:::

::: danger 忽略 `event: error`
只判断 `[DONE]`，会把中途错误当成正常结束，前端显示「回答完成」。
:::

::: danger 让代理层缓冲
Nginx、CDN、Serverless 网关都可能缓冲响应。至少设置 `X-Accel-Buffering: no` 和 `Cache-Control: no-transform`，并在部署层关闭缓冲。
:::

::: danger 用总超时管长回答
10 分钟的硬超时会截断正常的长文本。用「首字节 + 空闲 + 总预算」三层控制。
:::

## 检查清单

- [ ] SSE 按空行解析，不按网络分片解析
- [ ] 同时处理 `[DONE]`、`event: error`、直接断连
- [ ] 逐块转发，未缓存完整响应
- [ ] 客户端断开后取消上游
- [ ] 设置 `no-transform` 与 `x-accel-buffering: no`
- [ ] 部署层（Nginx / CDN / Serverless）已关闭缓冲
- [ ] 上游错误在首字节前返回真实状态码

## 下一步

统一的协议是下一个门槛：[统一协议：对齐 OpenAI](./openai-compat.md)。如果你更关心多模型切换，直接看[路由模式](../02-production/routing.md)。
