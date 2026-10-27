import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { WorkspaceStore } from '../server/storage.ts'
import { createApp } from '../server/app.ts'
import { LlamaClient, MAX_TOOL_ROUNDS } from '../server/llama.ts'
import { digestResults } from '../server/mcp.ts'
import { createChatState } from '../src/composables/useChat.ts'
import { createView } from '../src/chat/model.ts'
import { assertWorkspace, defaultVoicePreferences } from '../shared/workspace.ts'
import type { Workspace } from '../shared/workspace.ts'
import { defaultCharacter } from '../shared/characters.ts'
import type { ChatEvent } from '../shared/protocol.ts'

async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}` }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
const brave = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'text', text: JSON.stringify({ url: `https://example${i}.tw/page`, title: `<strong>結果</strong> ${i}`, description: `描述 &amp; 內容 ${i}`, extra_snippets: [`補充 ${i}`] }) }))
/** Fake MCP server answering over SSE like @brave/brave-search-mcp-server. */
function mcpServer() {
  const calls: { name: string; arguments: Record<string, unknown> }[] = []
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    if (!('id' in body)) { res.writeHead(202); res.end(); return }
    let result: unknown = {}
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
    if (body.method === 'tools/list') result = { tools: [{ name: 'brave_web_search' }, { name: 'brave_image_search' }] }
    if (body.method === 'tools/call') { calls.push(body.params); result = { content: brave(2) } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`)
  })
  return { server, calls }
}
/** Fake llama.cpp: each chat request takes the next scripted turn; a turn is text deltas or a tool call. */
function llama(turns: ({ text: string[] } | { tool: string; args: string })[]) {
  const requests: { messages: { role: string; content: string | null; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[] }[] = []
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part)
    const payload = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url === '/health') return json({ status: 'ok' })
    if (req.url === '/v1/models') return json({ data: [{ id: 'm' }] })
    if (req.url === '/props') return json({ default_generation_settings: { n_ctx: 8192 } })
    if (req.url === '/apply-template') return json({ prompt: 'p' })
    if (req.url === '/tokenize') return json({ tokens: [...payload.content].map((_, i) => i) })
    requests.push(payload)
    const turn = turns[Math.min(requests.length - 1, turns.length - 1)]!
    const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if ('tool' in turn) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: turn.tool, arguments: '' } }] } }] })
      for (const piece of [turn.args.slice(0, 5), turn.args.slice(5)]) send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] })
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      for (const delta of turn.text) send({ choices: [{ delta: { content: delta } }] })
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    }
    res.end('data: [DONE]\n\n')
  })
  return { server, requests }
}
const fixture = (): Workspace => ({ schemaVersion: 3, activeId: 'c1', characters: [defaultCharacter()], conversations: [{ id: 'c1', characterId: 'mio', title: 't', time: '剛剛', backgroundAssetId: null, sceneLabel: '', memoryCursor: 0, view: createView(), messages: [{ id: 'o', role: 'assistant', text: '你來了。', tokens: 0, source: 'estimate', origin: 'opening', status: 'complete' }] }], saved: [], preferences: { threshold: 300, speed: 32, maxTokens: 512, favoriteScope: 'all', favoriteQuery: '', search: '', ...defaultVoicePreferences() }, panelPolicy: { dismissed: [], autoOpened: [] } })

test('search results are compacted for the model and turned into safe sources', () => {
  const digest = digestResults([...brave(7), { type: 'text', text: JSON.stringify({ url: 'javascript:alert(1)', title: '壞連結' }) }, { type: 'text', text: '純文字結果' }])
  assert.equal(digest.sources.length, 5)
  assert.deepEqual(digest.sources[0], { title: '結果 0', url: 'https://example0.tw/page' })
  assert.match(digest.text, /\[1\] 結果 0\n描述 & 內容 0 補充 0\n來源：example0\.tw/)
  assert.ok(!digest.text.includes('<strong>') && !digest.sources.some(s => s.url.startsWith('javascript')))
  assert.equal(digestResults([]).text, '沒有找到相關結果。')
})

test('the model can search mid-reply: tool results go back to it, sources and the answer reach the reader', async () => {
  const model = llama([{ tool: 'web_search', args: '{"query":"台北天氣"}' }, { text: ['[表情:微笑]', '今天台北晴天。'] }])
  const url = await listen(model.server)
  let ran = ''
  const search = { tools: [{ type: 'function', function: { name: 'web_search' } }], run: async (_: string, query: string) => { ran = query; return { text: '台北晴 28 度', sources: [{ title: '氣象署', url: 'https://cwa.gov.tw' }] } } }
  try {
    const got: ChatEvent[] = []
    for await (const e of new LlamaClient(url).chat([{ role: 'user', content: '今天天氣？' }], 256, new AbortController().signal, 'sys', true, search)) got.push(e)
    assert.equal(ran, '台北天氣')
    assert.deepEqual(got.filter(e => e.type !== 'tokens' && e.type !== 'context' && e.type !== 'done').map(e => e.type), ['search', 'sources', 'expression', 'delta'])
    assert.equal(got.filter(e => e.type === 'delta').map(e => e.text).join(''), '今天台北晴天。')
    const followUp = model.requests[1]!.messages
    assert.deepEqual(followUp.at(-1), { role: 'tool', tool_call_id: 'call_a', content: '台北晴 28 度' })
    assert.equal((followUp.at(-2)!.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments, '{"query":"台北天氣"}')
  } finally { await close(model.server) }

  const stubborn = llama([{ tool: 'web_search', args: '{"query":"再查"}' }, { tool: 'web_search', args: '{"query":"再查"}' }, { text: ['好吧，就這樣。'] }])
  const stubbornUrl = await listen(stubborn.server)
  try {
    let text = ''
    for await (const e of new LlamaClient(stubbornUrl).chat([{ role: 'user', content: 'q' }], 256, new AbortController().signal, 'sys', false, { ...search, run: async () => { throw new Error('服務離線') } })) if (e.type === 'delta') text += e.text
    assert.equal(text, '好吧，就這樣。')
    assert.equal(stubborn.requests.length, MAX_TOOL_ROUNDS + 1)
    assert.equal(stubborn.requests.at(-1)!.tools, undefined, 'the final round must answer instead of searching again')
    assert.match(stubborn.requests[1]!.messages.at(-1)!.content!, /搜尋失敗：服務離線/)
  } finally { await close(stubborn.server) }
})

test('chat offers search only when the MCP server is reachable, and calls it with Taiwan defaults', async () => {
  const mcp = mcpServer(), mcpUrl = await listen(mcp.server)
  const model = llama([{ tool: 'web_search', args: '{"query":"新番"}' }, { text: ['查到了。'] }]), llamaUrl = await listen(model.server)
  const store = new WorkspaceStore(':memory:'); store.save(0, 'w', fixture())
  const on = createApp(new LlamaClient(llamaUrl), store, { searchUrl: `${mcpUrl}/mcp` }), onBase = await listen(on)
  const off = createApp(new LlamaClient(llamaUrl), store, { searchUrl: 'http://127.0.0.1:9/mcp' }), offBase = await listen(off)
  const chat = (base: string) => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'mio', messages: [{ role: 'user', content: '最近有什麼新番？' }] }) }).then(r => r.text())
  try {
    assert.equal((await (await fetch(`${onBase}/api/status`)).json()).search, true)
    const stream = await chat(onBase)
    assert.match(stream, /"type":"search","query":"新番"/); assert.match(stream, /"type":"sources"/); assert.match(stream, /查到了。/)
    assert.deepEqual(mcp.calls, [{ name: 'brave_web_search', arguments: { query: '新番', country: 'TW', search_lang: 'zh-hant', ui_lang: 'zh-TW', count: 5 } }])
    assert.deepEqual(model.requests[0]!.tools!.map(t => t.function.name), ['web_search'], 'only mapped tools that the server provides')
    assert.match(model.requests[0]!.messages[0]!.content!, /【上網】/)

    assert.equal((await (await fetch(`${offBase}/api/status`)).json()).search, false)
    model.requests.length = 0
    await chat(offBase)
    assert.equal(model.requests[0]!.tools, undefined); assert.doesNotMatch(model.requests[0]!.messages[0]!.content!, /【上網】/)
  } finally { await close(on); await close(off); await close(mcp.server); await close(model.server); store.close() }
})

test('frontend keeps searches and sources on the reply, shows a searching hint and persists them', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(done => { release = done })
  const fetcher: typeof fetch = async url => {
    if (url === '/api/status') return Response.json({ connected: true, model: 't', endpoint: '', search: true })
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({ async start(controller) {
      const send = (e: ChatEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
      send({ type: 'search', query: '台北天氣' }); await gate
      send({ type: 'sources', sources: [{ title: '氣象署', url: 'https://cwa.gov.tw' }, { title: '氣象署', url: 'https://cwa.gov.tw' }] })
      send({ type: 'delta', text: '晴天喔。' }); send({ type: 'done', count: 4, source: 'tokenizer', finishReason: 'stop' }); controller.close()
    } }))
  }
  const chat = createChatState(fetcher)
  try {
    await chat.checkConnection(); assert.equal(chat.searchAvailable.value, true)
    chat.input.value = '今天天氣如何'; const task = chat.respond()
    await new Promise(r => setTimeout(r, 20))
    assert.equal(chat.readingHint.value, '澪正在上網查「台北天氣」…')
    release(); await task
    assert.deepEqual(chat.displayMessage.value.searches, ['台北天氣'])
    assert.deepEqual(chat.displayMessage.value.sources, [{ title: '氣象署', url: 'https://cwa.gov.tw' }], 'duplicate sources are merged')
    const value = fixture(); value.conversations[0]!.messages.push({ id: 'u', role: 'user', text: 'q', tokens: 0, source: 'estimate', origin: 'model', status: 'complete' }, { ...chat.displayMessage.value, id: 'a', responseTo: 'u' })
    assertWorkspace(value)
    value.conversations[0]!.messages[2]!.sources = [{ title: 'x', url: 'javascript:alert(1)' }]
    assert.throws(() => assertWorkspace(value))
  } finally { chat.dispose() }
})
