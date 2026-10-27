import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { createApp } from '../server/app.ts'
import { LlamaClient } from '../server/llama.ts'

async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const a = server.address(); assert.ok(a && typeof a !== 'string'); return `http://127.0.0.1:${a.port}` }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }

test('the TTS voice list is relayed from the local service, sanitised, and optional for generic services', async () => {
  let reply: { status: number; body: unknown } = { status: 200, body: { default: 'zf_001', voices: [{ id: 'zf_001', label: '中文女聲 001' }, { id: 'zm_010', label: '中文男聲 010' }, { id: 42, label: 'bad' }, { id: '', label: 'empty' }] } }
  const tts = createServer((req, res) => {
    assert.equal(req.url, '/voices')
    res.writeHead(reply.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply.body))
  })
  const ttsBase = await listen(tts)
  const off = createApp(new LlamaClient('http://127.0.0.1:9')), offBase = await listen(off)
  const on = createApp(new LlamaClient('http://127.0.0.1:9'), undefined, { ttsUrl: `${ttsBase}/tts` }), onBase = await listen(on)
  const voices = (base: string) => fetch(`${base}/api/tts/voices`)
  try {
    assert.equal((await voices(offBase)).status, 503)
    assert.deepEqual(await (await voices(onBase)).json(), { default: 'zf_001', voices: [{ id: 'zf_001', label: '中文女聲 001' }, { id: 'zm_010', label: '中文男聲 010' }] })
    reply = { status: 200, body: { default: 'ghost', voices: [{ id: 'zf_001', label: 'x' }] } }
    assert.equal((await (await voices(onBase)).json()).default, null, 'a default that is not in the list is dropped')
    reply = { status: 404, body: { error: 'no' } }
    assert.deepEqual(await (await voices(onBase)).json(), { voices: [], default: null }, 'services without /voices fall back to free text')
    reply = { status: 500, body: { error: 'boom' } }
    assert.equal((await voices(onBase)).status, 502)
  } finally { await close(on); await close(off); await close(tts) }
})

test('speech requests use the voice and speed the browser sends, falling back to the stored character voice', async () => {
  const { WorkspaceStore } = await import('../server/storage.ts')
  const { createView } = await import('../src/chat/model.ts')
  const { defaultCharacter } = await import('../shared/characters.ts')
  const { defaultVoicePreferences } = await import('../shared/workspace.ts')
  let received: Record<string, unknown> = {}
  const tts = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const p of req) parts.push(p)
    received = JSON.parse(Buffer.concat(parts).toString())
    if (received.voice === 'ghost') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '沒有這個聲音：ghost' })); return }
    res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end('RIFF')
  })
  const store = new WorkspaceStore(':memory:')
  const mio = { ...defaultCharacter(), voice: { ...defaultCharacter().voice, httpVoice: 'zf_001', rate: 1 } }
  store.save(0, 'w', { schemaVersion: 3, activeId: 'c', characters: [mio], conversations: [{ id: 'c', characterId: 'mio', title: 't', time: '', backgroundAssetId: null, sceneLabel: '', memoryCursor: 0, view: createView(), messages: [{ id: 'o', role: 'assistant', text: '你好', tokens: 0, source: 'estimate', origin: 'opening', status: 'complete' }] }], saved: [], preferences: { threshold: 300, speed: 32, maxTokens: 512, favoriteScope: 'all', favoriteQuery: '', search: '', ...defaultVoicePreferences() }, panelPolicy: { dismissed: [], autoOpened: [] } })
  const app = createApp(new LlamaClient('http://127.0.0.1:9'), store, { ttsUrl: `${await listen(tts)}/tts` }), base = await listen(app)
  const speak = (body: object) => fetch(`${base}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'mio', text: '你好', ...body }) })
  try {
    assert.equal((await speak({})).status, 200); assert.deepEqual(received, { text: '你好', voice: 'zf_001', speed: 1 }, 'stored voice when none is sent')
    assert.equal((await speak({ voice: 'zm_010', speed: 1.3 })).status, 200); assert.deepEqual(received, { text: '你好', voice: 'zm_010', speed: 1.3 }, 'an unsaved preview uses the chosen voice')
    assert.equal((await speak({ voice: 7 })).status, 400); assert.equal((await speak({ speed: 9 })).status, 400)
    const bad = await speak({ voice: 'ghost' }); assert.equal(bad.status, 502); assert.match((await bad.json()).error, /沒有這個聲音：ghost/)
  } finally { await close(app); await close(tts); store.close() }
})
