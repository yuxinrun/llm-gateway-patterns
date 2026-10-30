---
title: Minimal TS gateway and SSE forwarding
description: Build a minimal TypeScript gateway with Hono and handle SSE chunking, backpressure and disconnects correctly.
---

# Minimal TS gateway and SSE forwarding

Node.js teams often get stuck in the same place: the Python version works, but under Node the SSE stream is "sometimes complete, sometimes cut off". The cause is usually not the gateway, but **treating network chunks as SSE events**.

This chapter builds a minimal TypeScript gateway, then explains SSE parsing thoroughly.

## Project setup

```bash
mkdir ts-gateway && cd ts-gateway
npm init -y
npm pkg set type=module
npm i hono @hono/node-server
npm i -D tsx typescript
```

Directory layout:

```text
ts-gateway/
├── src/
│   ├── gateway.ts   # gateway
│   └── sse.ts       # SSE parser
└── package.json
```

## Gateway code

`src/gateway.ts`:

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
      // Demo-only total cap; in production use "first-byte timeout + idle timeout + total budget"
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

    // Cancel the upstream read when the client disconnects, so the connection is freed quickly
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

Run it:

```bash
export UPSTREAM_BASE_URL="https://api.deepseek.com/v1"
export UPSTREAM_API_KEY="sk-your-real-key"
export DEFAULT_MODEL="deepseek-chat"
npx tsx src/gateway.ts
```

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"Explain SSE in three sentences"}]}'
```

## How many layers does SSE actually have

This is the key to every "streaming mystery". There is **no one-to-one mapping** between a single network read and a single SSE event.

```text
┌────────────────────────────────────────────────────────────────┐
│ 1. TCP / HTTP chunk: any length, may split an event            │
├────────────────────────────────────────────────────────────────┤
│ 2. SSE event: separated by a blank line; data may span lines   │
├────────────────────────────────────────────────────────────────┤
│ 3. Model delta: choices[0].delta.content inside the JSON       │
└────────────────────────────────────────────────────────────────┘
```

One event looks like this:

```text
event: message
data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"Hel"}}]}

```

The rules:

- Only a blank line (`\n\n`) ends an event.
- Lines starting with `:` are comments, commonly used as heartbeats.
- One event can have multiple `data:` lines, joined with `\n`.
- `data: [DONE]` is an OpenAI convention, not part of the SSE standard.
- Never assume "one `reader.read()` = one complete JSON".

## Client parser

`src/sse.ts`:

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

Usage:

```ts
const res = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-chat',
    stream: true,
    messages: [{ role: 'user', content: 'Count to 10' }]
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

::: tip Why not use `EventSource` in the browser
`EventSource` only sends GET, cannot carry custom request headers, and cannot submit a JSON request body. For chat, use `fetch` + `ReadableStream` with the same parsing logic as above.
:::

## Three design points

### 1. Forward chunk by chunk; do not accumulate and send at the end

```ts
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  if (value) await s.write(value)
}
```

If you `await upstream.text()` first and then return, streaming degrades into non-streaming: users wait for the full answer, and TTFT equals total duration.

### 2. Backpressure must travel through `await`

`await s.write(value)` does more than "write it out": it applies backpressure when the consumer cannot keep up. Do not change it to "collect into an array and write later" — that hands memory control to an unbounded downstream.

### 3. Disconnects must cancel upstream

Cancel the `reader` in `s.onAbort()` so the upstream connection is released quickly. Otherwise, after a user closes the page, the model keeps generating and tokens keep billing.

::: warning Node adapter details
Different deployment targets (Node server, serverless, edge) do not support `onAbort` and `Request.signal` identically. Before launch, run a "close the page mid-stream" test with a real client and confirm the upstream request is actually cancelled.
:::

## Differences from the Python version

| Dimension | Python (httpx) | TypeScript (fetch / Hono) |
| --- | --- | --- |
| Timeouts | Four separate values | Only a total timeout natively; implement idle timeout yourself |
| Decompression | `aiter_bytes()` decompresses automatically | `fetch` decompresses automatically |
| Disconnects | Generator cancellation + `finally` | `stream.onAbort` + `reader.cancel` |
| Connection pool | `httpx.AsyncClient` | undici global dispatcher, tunable via an Agent |
| Status codes | `send` first, then decide the response | `fetch` first, then decide the response |

## Common pitfalls

::: danger Splitting JSON on `\n`
A network chunk can break at any byte. Split events on blank lines, then aggregate `data:` lines.
:::

::: danger Ignoring `event: error`
If you only check `[DONE]`, a mid-stream error looks like a normal finish and the frontend shows "answer complete".
:::

::: danger Letting the proxy layer buffer
Nginx, CDNs and serverless gateways may all buffer responses. At minimum set `X-Accel-Buffering: no` and `Cache-Control: no-transform`, and disable buffering at the deployment layer.
:::

::: danger Using a total timeout to govern long answers
A hard 10-minute timeout truncates legitimate long-form text. Use three layers: "first byte + idle + total budget".
:::

## Checklist

- [ ] SSE parsed by blank lines, not by network chunks
- [ ] `[DONE]`, `event: error` and abrupt disconnects all handled
- [ ] Chunks forwarded as they arrive; no full-response buffering
- [ ] Upstream cancelled after the client disconnects
- [ ] `no-transform` and `x-accel-buffering: no` set
- [ ] Buffering disabled at the deployment layer (Nginx / CDN / serverless)
- [ ] Real status codes returned for upstream errors before the first byte

## Next steps

A single protocol is the next hurdle: [One protocol: aligning on OpenAI](./openai-compat.md). If you care more about switching models, go straight to [routing patterns](../02-production/routing.md).
