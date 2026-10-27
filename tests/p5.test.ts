import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { WorkspaceStore, StoreError } from '../server/storage.ts'
import { createApp } from '../server/app.ts'
import { LlamaClient, parseMemories } from '../server/llama.ts'
import { createChatState, MEMORY_BATCH } from '../src/composables/useChat.ts'
import { createView } from '../src/chat/model.ts'
import { defaultVoicePreferences } from '../shared/workspace.ts'
import type { Workspace } from '../shared/workspace.ts'
import { defaultCharacter, memoryPrompt, takeExpression } from '../shared/characters.ts'
import type { Character } from '../shared/characters.ts'
import type { ChatEvent } from '../shared/protocol.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const rin = (): Character => ({ ...defaultCharacter(), id: 'rin', name: '凜', greeting: '星星出來了。', systemPrompt: '你是凜。', voice: { browserVoice: '', httpVoice: 'rin-v1', rate: 1.2, pitch: 1 } })
function fixture(): Workspace {
  return { schemaVersion: 3, activeId: 'c1', characters: [defaultCharacter(), rin()], conversations: [
    { id: 'c1', characterId: 'rin', title: '屋頂', time: '剛剛', backgroundAssetId: null, sceneLabel: '', memoryCursor: 0, view: createView(), messages: [{ id: 'o1', role: 'assistant', text: '星星出來了。', tokens: 0, source: 'estimate', origin: 'opening', status: 'complete' }] },
  ], saved: [], preferences: { threshold: 300, speed: 32, maxTokens: 512, favoriteScope: 'all', favoriteQuery: '', search: '', ...defaultVoicePreferences() }, panelPolicy: { dismissed: [], autoOpened: [] } }
}
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}` }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
/** A fake llama.cpp: `deltas` stream for chat; `summary` answers non-streaming requests (or hangs until cancelled). */
function llama(options: { deltas?: string[]; summary?: string | 'hang' } = {}) {
  const seen = { prompt: '', summaryRequests: 0, summaryCancelled: false }
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part)
    const payload = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url === '/health') return json({ status: 'ok' })
    if (req.url === '/v1/models') return json({ data: [{ id: 'm' }] })
    if (req.url === '/props') return json({ default_generation_settings: { n_ctx: 8192 } })
    if (req.url === '/apply-template') return json({ prompt: 'p' })
    if (req.url === '/tokenize') return json({ tokens: [...payload.content].map((_, i) => i) })
    if (!payload.stream) {
      seen.summaryRequests++
      if (options.summary === 'hang') { res.on('close', () => { seen.summaryCancelled = true }); return }
      return json({ choices: [{ message: { content: options.summary ?? '[]' } }] })
    }
    seen.prompt = payload.messages[0].content
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const delta of options.deltas ?? ['嗯。']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  return { server, seen }
}
async function events(response: Response) {
  const text = await response.text()
  return text.split('\n\n').filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)) as ChatEvent)
}

test('expression tags are recognised across chunk boundaries and never leak into dialogue', () => {
  assert.deepEqual(takeExpression('[表'), { pending: true })
  assert.deepEqual(takeExpression('  '), { pending: true })
  assert.deepEqual(takeExpression('[表情:開心]\n今天'), { pending: false, expression: 'happy', text: '今天' })
  assert.deepEqual(takeExpression('【害羞】嗯'), { pending: false, expression: 'shy', text: '嗯' })
  assert.deepEqual(takeExpression('[surprised]欸'), { pending: false, expression: 'surprised', text: '欸' })
  assert.deepEqual(takeExpression('[注意] 這是台詞'), { pending: false, expression: null, text: '[注意] 這是台詞' })
  assert.deepEqual(takeExpression('你好'), { pending: false, expression: null, text: '你好' })
  assert.deepEqual(takeExpression('[一段很長而且沒有結束的方括號內容一直延續下去'), { pending: false, expression: null, text: '[一段很長而且沒有結束的方括號內容一直延續下去' })
})

test('the stream emits the expression first and counts only visible dialogue', async () => {
  const mock = llama({ deltas: ['[表', '情:開心]', '\n', '今天', '真好'] }), url = await listen(mock.server)
  try {
    const got: ChatEvent[] = []
    for await (const e of new LlamaClient(url).chat([{ role: 'user', content: '嗨' }], 128, new AbortController().signal, 'sys', true)) got.push(e)
    assert.deepEqual(got.filter(e => e.type === 'expression'), [{ type: 'expression', expression: 'happy' }])
    assert.equal(got.filter(e => e.type === 'delta').map(e => e.text).join(''), '今天真好')
    const done = got.find(e => e.type === 'done'); assert.ok(done && done.type === 'done'); assert.equal(done.count, 4)
    const short: ChatEvent[] = []
    const plain = llama({ deltas: ['嗯'] }), plainUrl = await listen(plain.server)
    try { for await (const e of new LlamaClient(plainUrl).chat([{ role: 'user', content: '嗨' }], 128, new AbortController().signal, 'sys', true)) short.push(e) }
    finally { await close(plain.server) }
    assert.equal(short.filter(e => e.type === 'delta').map(e => e.text).join(''), '嗯', 'a reply shorter than a tag is still shown')
  } finally { await close(mock.server) }
})

test('chat prompts include stored memories only while memory is enabled', async () => {
  const mock = llama(), store = new WorkspaceStore(':memory:')
  const value = fixture(); value.characters[1]!.memories = [{ id: 'm1', text: '使用者叫小凱', source: 'manual', createdAt: 'x' }, { id: 'm2', text: '使用者喜歡雨天', source: 'auto', createdAt: 'x' }]
  store.save(0, 'w1', value)
  const app = createApp(new LlamaClient(await listen(mock.server)), store), base = await listen(app)
  const chat = () => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'rin', messages: [{ role: 'user', content: '你好' }] }) }).then(r => r.text())
  try {
    await chat(); assert.match(mock.seen.prompt, /長期記憶[\s\S]*使用者叫小凱[\s\S]*使用者喜歡雨天/)
    value.characters[1]!.memoryEnabled = false; store.save(1, 'w2', value)
    await chat(); assert.doesNotMatch(mock.seen.prompt, /長期記憶/)
    assert.equal(memoryPrompt([]), '')
    const long = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, text: `第${i}件事`.padEnd(100, '。'), source: 'auto' as const, createdAt: 'x' }))
    const prompt = memoryPrompt(long)
    assert.ok(prompt.includes('第29件事') && !prompt.includes('第0件事'), 'the newest automatic memories win the budget')
  } finally { await close(app); await close(mock.server); store.close() }
})

test('memory summaries parse loosely, skip known facts and yield to a new chat', async () => {
  assert.deepEqual(parseMemories('```json\n["使用者叫小凱", "使用者叫小凱", "使用者養了一隻貓"]\n```', ['使用者養了一隻貓']), ['使用者叫小凱'])
  assert.deepEqual(parseMemories('沒有新事項'), [])
  assert.deepEqual(parseMemories('[1, null, "  "]'), [])
  const store = new WorkspaceStore(':memory:'); store.save(0, 'w', fixture())
  const ok = llama({ summary: '["使用者明天要考試"]' }), okApp = createApp(new LlamaClient(await listen(ok.server)), store), okBase = await listen(okApp)
  const summarize = (base: string, body: object = { characterId: 'rin', messages: [{ role: 'user', content: '我明天要考試' }, { role: 'assistant', content: '加油。' }] }) =>
    fetch(`${base}/api/memory/summarize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.deepEqual(await (await summarize(okBase)).json(), { memories: ['使用者明天要考試'] })
    assert.equal((await summarize(okBase, { characterId: 'rin', messages: [] })).status, 400)
    assert.equal((await summarize(okBase, { characterId: 'ghost', messages: [{ role: 'user', content: 'x' }] })).status, 404)
  } finally { await close(okApp); await close(ok.server) }
  const slow = llama({ summary: 'hang' }), app = createApp(new LlamaClient(await listen(slow.server)), store), base = await listen(app)
  try {
    const pending = summarize(base)
    while (!slow.seen.summaryRequests) await new Promise(r => setTimeout(r, 5))
    const reply = await events(await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'rin', messages: [{ role: 'user', content: '你好' }] }) }))
    assert.ok(reply.some(e => e.type === 'done'), 'the chat ran instead of waiting behind the summary')
    const summary = await pending
    assert.equal(summary.status, 409); assert.ok(slow.seen.summaryCancelled)
  } finally { await close(app); await close(slow.server); store.close() }
})

test('TTS proxies the character voice to the configured server and rejects non-audio', async () => {
  let received: Record<string, unknown> = {}, type = 'audio/wav'
  const tts = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part)
    received = JSON.parse(Buffer.concat(parts).toString())
    res.writeHead(200, { 'Content-Type': type }); res.end(Buffer.from('RIFFfake'))
  })
  const store = new WorkspaceStore(':memory:'); store.save(0, 'w', fixture())
  const ttsUrl = await listen(tts)
  const off = createApp(new LlamaClient('http://127.0.0.1:9'), store), offBase = await listen(off)
  const on = createApp(new LlamaClient('http://127.0.0.1:9'), store, { ttsUrl }), onBase = await listen(on)
  const speak = (base: string, text = '星星出來了。') => fetch(`${base}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'rin', text }) })
  try {
    assert.equal((await speak(offBase)).status, 503)
    const audio = await speak(onBase)
    assert.equal(audio.status, 200); assert.equal(audio.headers.get('content-type'), 'audio/wav'); assert.equal(await audio.text(), 'RIFFfake')
    assert.deepEqual(received, { text: '星星出來了。', voice: 'rin-v1', speed: 1.2 })
    assert.equal((await speak(onBase, '')).status, 400)
    type = 'text/html'; assert.equal((await speak(onBase)).status, 502)
  } finally { await close(off); await close(on); await close(tts); store.close() }
})

test('scenes and expression portraits are durable references that block asset deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-p5-test-'))
  const store = new WorkspaceStore(join(root, 'w.sqlite'))
  try {
    const background = store.addAsset('background', 'night.png', PNG), portrait = store.addAsset('portrait', 'smile.png', PNG)
    const value = fixture(); value.conversations[0]!.backgroundAssetId = background.id; value.conversations[0]!.sceneLabel = '頂樓'
    value.characters[1]!.expressions = { happy: portrait.id }
    store.save(0, 'w1', value)
    const restored = store.read().snapshot!
    assert.equal(restored.conversations[0]!.backgroundAssetId, background.id); assert.equal(restored.conversations[0]!.sceneLabel, '頂樓')
    assert.deepEqual(restored.characters[1]!.expressions, { happy: portrait.id })
    assert.throws(() => store.deleteAsset(background.id), /頂樓|屋頂/)
    assert.throws(() => store.deleteAsset(portrait.id), /凜/)
    const wrong = structuredClone(value); wrong.characters[1]!.expressions = { happy: background.id }
    assert.throws(() => store.save(1, 'w2', wrong), StoreError)
    const gone = structuredClone(value); gone.conversations[0]!.backgroundAssetId = 'missing'
    assert.throws(() => store.save(1, 'w3', gone), /場景/)
    const badKey = structuredClone(value) as unknown as { characters: { expressions: Record<string, string> }[] }; badKey.characters[1]!.expressions = { giggle: portrait.id }
    assert.throws(() => store.save(1, 'w4', badKey as unknown as Workspace), /來源關聯/)
  } finally {
    store.close()
    const absolute = resolve(root); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep)); await rm(absolute, { recursive: true, force: true })
  }
})

test('frontend: expressions drive the stage and history, memories are managed and summarised, scenes apply per conversation', async () => {
  const chats: { messages: { role: string; content: string }[]; characterId: string }[] = []
  let summaryBody: { messages: unknown[] } | null = null
  const sse = (items: ChatEvent[]) => new Response(items.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''))
  const fetcher: typeof fetch = async (url, init) => {
    if (url === '/api/status') return Response.json({ connected: true, model: 'test', endpoint: '', tts: false })
    if (url === '/api/chat') { chats.push(JSON.parse(init!.body as string)); return sse([{ type: 'expression', expression: 'shy' }, { type: 'delta', text: '才、才沒有。' }, { type: 'done', count: 5, source: 'tokenizer', finishReason: 'stop' }]) }
    if (url === '/api/memory/summarize') { summaryBody = JSON.parse(init!.body as string); return Response.json({ memories: ['使用者誇獎過凜'] }) }
    if (url === '/api/assets') return Response.json({ assets: [] })
    throw new Error(`Unexpected request ${url}`)
  }
  const chat = createChatState(fetcher)
  try {
    assert.equal(chat.saveCharacter(rin()), ''); chat.addConversation('rin')
    assert.equal(chat.stageExpression.value, 'smile')
    chat.input.value = '你今天很可愛'; await chat.respond()
    assert.equal(chat.displayMessage.value.expression, 'shy'); assert.equal(chat.stageExpression.value, 'shy'); assert.equal(chat.displayMessage.value.text, '才、才沒有。')
    chat.input.value = '真的'; await chat.respond()
    assert.equal(chats[1]!.messages.find(m => m.role === 'assistant' && m.content.includes('才、才'))!.content, '[表情:害羞]才、才沒有。')

    assert.match(chat.addMemory('rin', ' '), /1 到 300/)
    assert.equal(chat.addMemory('rin', '使用者叫小凱'), '')
    const memoryId = chat.activeCharacter.value.memories[0]!.id
    assert.equal(chat.saveCharacter({ ...rin(), name: '凜醬' }), '')
    assert.equal(chat.activeCharacter.value.memories.length, 1, 'saving the form keeps memories added meanwhile')
    assert.equal(await chat.summarizeNow(), 1)
    assert.equal(summaryBody!.messages.length, 4, 'two exchanges since the cursor; the scripted opening is not a memory')
    assert.deepEqual(chat.activeCharacter.value.memories.map(m => [m.text, m.source]), [['使用者叫小凱', 'manual'], ['使用者誇獎過凜', 'auto']])
    assert.equal(chat.active.value.memoryCursor, chat.active.value.messages.length)
    assert.equal(await chat.summarizeNow(), 0, 'nothing new to summarise')
    const auto = chat.activeCharacter.value.memories[1]!.id
    assert.equal(chat.updateMemory('rin', auto, '使用者常誇獎凜'), ''); assert.equal(chat.activeCharacter.value.memories[1]!.source, 'manual')
    chat.deleteMemory('rin', memoryId); assert.equal(chat.activeCharacter.value.memories.length, 1)
    assert.ok(MEMORY_BATCH > 2)

    await chat.loadAssets()
    assert.match(chat.setScene(chat.activeId.value, 'missing', ''), /背景已不存在/)
    assert.equal(chat.setScene(chat.activeId.value, null, '  天台  '), ''); assert.equal(chat.active.value.sceneLabel, '天台')
  } finally { chat.dispose() }
})
