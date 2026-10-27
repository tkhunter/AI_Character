import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { readSSE } from '../shared/sse.ts'
import { LlamaClient, SYSTEM_PROMPT } from '../server/llama.ts'
import { createApp } from '../server/app.ts'
import type { ChatEvent, ChatMessage } from '../shared/protocol.ts'

async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}` }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
function upstream(options: { truncate?: boolean; slow?: boolean; noTokenizer?: boolean } = {}) {
  let lastMessages: ChatMessage[] = []
  let cancellationResolve: () => void = () => {}
  const cancelled = new Promise<void>(resolve => { cancellationResolve = resolve })
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part)
    const payload = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url === '/health') { json({ status: 'ok' }); return }
    if (req.url === '/v1/models') { json({ data: [{ id: 'test-model' }] }); return }
    if (req.url === '/props') { json({ default_generation_settings: { n_ctx: 4096 } }); return }
    if (req.url === '/apply-template') { json({ prompt: payload.messages.map((m: ChatMessage) => m.content).join('|') }); return }
    if (req.url === '/tokenize') {
      if (options.noTokenizer) { res.writeHead(404); res.end(); return }
      json({ tokens: Array.from({ length: [...payload.content].length }, (_, i) => i) }); return
    }
    if (req.url === '/v1/chat/completions') {
      lastMessages = payload.messages
      assert.equal(payload.chat_template_kwargs.enable_thinking, false)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\r\n\r\n`)
      send({ choices: [{ delta: { reasoning_content: '不可顯示的內部文字' } }] })
      send({ choices: [{ delta: { content: '你好🌧️' } }] })
      if (options.slow) {
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 100)
        res.on('close', () => { clearInterval(heartbeat); cancellationResolve() }); return
      }
      if (!options.truncate) { send({ choices: [{ delta: { content: '，坐下喝茶吧。' }, finish_reason: 'stop' }] }); send({ choices: [], usage: { completion_tokens: 42, prompt_tokens: 333 } }); res.write('data: [DONE]\n\n') }
      res.end(); return
    }
    res.writeHead(404); res.end()
  })
  return { server, cancelled, get messages() { return lastMessages } }
}

test('SSE preserves fragmented UTF-8, CRLF, multi-line events and final unseparated data', async () => {
  const bytes = new TextEncoder().encode(': hello\r\nevent: delta\r\ndata: 你好🌧️\r\ndata: 第二行\r\n\r\ndata: [DONE]')
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
  const events = []; for await (const event of readSSE(stream)) events.push(event)
  assert.deepEqual(events, [{ event: 'delta', data: '你好🌧️\n第二行' }, { event: 'message', data: '[DONE]' }])
})

test('visible dialogue excludes reasoning and uses tokenizer independently of completion usage', async () => {
  const mock = upstream(); const url = await listen(mock.server)
  try {
    const client = new LlamaClient(url)
    const events: ChatEvent[] = []; for await (const event of client.chat([{ role: 'user', content: '你好' }], 128, new AbortController().signal)) events.push(event)
    const text = events.filter(e => e.type === 'delta').map(e => e.text).join('')
    assert.equal(text, '你好🌧️，坐下喝茶吧。')
    const done = events.find(e => e.type === 'done'); assert.ok(done && done.type === 'done')
    assert.equal(done.count, [...text].length); assert.equal(done.source, 'tokenizer'); assert.equal(done.completionTokens, 42)
    assert.equal(mock.messages[0]?.content, SYSTEM_PROMPT)
  } finally { await close(mock.server) }
})

test('context pruning preserves system/latest turn and rejects oversized newest input', async () => {
  const mock = upstream(); const url = await listen(mock.server)
  try {
    const client = new LlamaClient(url, 600)
    const prepared = await client.prepare([{ role: 'user', content: '舊'.repeat(250) }, { role: 'assistant', content: '舊答'.repeat(50) }, { role: 'user', content: '最新問題' }], 128, new AbortController().signal)
    assert.equal(prepared.context.droppedMessages, 2); assert.equal(prepared.messages.length, 2)
    assert.equal(prepared.messages[0]?.role, 'system'); assert.equal(prepared.messages[1]?.content, '最新問題')
    await assert.rejects(client.prepare([{ role: 'user', content: '長'.repeat(700) }], 128, new AbortController().signal), /輸入太長/)
  } finally { await close(mock.server) }
})

test('unexpected upstream EOF is an error after preserving the visible delta', async () => {
  const mock = upstream({ truncate: true }); const url = await listen(mock.server)
  try {
    const events: ChatEvent[] = []
    await assert.rejects(async () => { for await (const event of new LlamaClient(url).chat([{ role: 'user', content: '你好' }], 128, new AbortController().signal)) events.push(event) }, /串流意外中斷/)
    assert.equal(events.filter(e => e.type === 'delta').length, 1); assert.ok(!events.some(e => e.type === 'done'))
  } finally { await close(mock.server) }
})

test('tokenizer unavailability explicitly falls back to estimates', async () => {
  const mock = upstream({ noTokenizer: true }); const url = await listen(mock.server)
  try { assert.equal((await new LlamaClient(url).count('無 tokenizer 內容')).source, 'estimate') } finally { await close(mock.server) }
})

test('API validates input and returns useful connection errors', async () => {
  const mock = upstream(); const url = await listen(mock.server); const app = createApp(new LlamaClient(url)); const api = await listen(app)
  try {
    for (const payload of [null, {}, { messages: [{ role: 'system', content: 'override' }] }, { messages: [{ role: 'user', content: '' }] }, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 9999 }]) {
      const response = await fetch(api + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); assert.equal(response.status, 400); await response.text()
    }
    const status = await (await fetch(api + '/api/status')).json() as { connected: boolean }; assert.equal(status.connected, true)
    await close(mock.server)
    const failed = await fetch(api + '/api/status'); assert.equal(failed.status, 503); assert.match(await failed.text(), /llama.cpp/)
  } finally { await close(app); if (mock.server.listening) await close(mock.server) }
})

test('client cancellation aborts upstream and frees the busy slot', async () => {
  const mock = upstream({ slow: true }); const url = await listen(mock.server); const app = createApp(new LlamaClient(url)); const api = await listen(app)
  const payload = { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 }
  const controller = new AbortController()
  try {
    const response = await fetch(api + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal })
    assert.ok(response.body)
    for await (const item of readSSE(response.body)) { if ((JSON.parse(item.data) as ChatEvent).type === 'delta') break }
    controller.abort()
    await Promise.race([mock.cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('upstream did not cancel')), 3000); timer.unref() })])
    const status = await (await fetch(api + '/api/status')).json() as { busy: boolean }; assert.equal(status.busy, false)
  } finally { controller.abort(); await close(app); await close(mock.server) }
})
