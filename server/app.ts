import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { LlamaClient, ServiceError, type SearchHandler } from './llama.ts'
import { McpClient, SEARCH_INSTRUCTION, SEARCH_TOOLS, digestResults, toolDefinitions } from './mcp.ts'
import type { ChatMessage } from '../shared/protocol.ts'
import { assertWorkspace } from '../shared/workspace.ts'
import { StorageConflict, StoreError, type WorkspaceStore } from './storage.ts'
import { ASSET_MAX_BYTES, EXPRESSION_INSTRUCTION, memoryPrompt } from '../shared/characters.ts'
import { IMPORT_LIMITS } from './live2dImport.ts'

function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)) }
async function readBytes(request: IncomingMessage, limit: number) {
  let size = 0
  const parts: Buffer[] = []
  for await (const part of request) {
    size += part.length
    if (size > limit) throw new ServiceError('請求內容太大。', 413)
    parts.push(part)
  }
  return Buffer.concat(parts)
}
async function readBody(request: IncomingMessage, limit = 1024 * 1024) {
  const bytes = await readBytes(request, limit)
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new ServiceError('請求格式錯誤。', 400) }
}
function decodeId(value: string) { try { return decodeURIComponent(value) } catch { throw new ServiceError('素材編號格式錯誤。', 400) } }
const validTranscript = (messages: unknown, max: number) => Array.isArray(messages) && messages.length > 0 && messages.length <= max && messages.every((m: ChatMessage) => !!m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && !!m.content.trim() && m.content.length <= 20000)
export function createApp(client: LlamaClient, store?: WorkspaceStore, options: { ttsUrl?: string; searchUrl?: string } = {}) {
  const mcp = options.searchUrl ? new McpClient(options.searchUrl) : null
  // Cache which search tools exist; an offline search server simply means chatting without tools.
  let toolCache: { at: number; names: string[] } | null = null
  async function searchTools(signal: AbortSignal) {
    if (!mcp) return []
    if (toolCache && Date.now() - toolCache.at < (toolCache.names.length ? 300000 : 30000)) return toolCache.names
    let names: string[] = []
    try { names = (await mcp.tools(signal)).map(t => t.name) } catch { if (signal.aborted) throw signal.reason; mcp.initialized = false; mcp.session = null }
    toolCache = { at: Date.now(), names }
    return names
  }
  async function searchHandler(signal: AbortSignal): Promise<SearchHandler | undefined> {
    const tools = toolDefinitions(await searchTools(signal))
    if (!tools.length || !mcp) return undefined
    return { tools, run: async (name, query, runSignal) => {
      const tool = SEARCH_TOOLS.find(t => t.name === name)
      if (!tool) throw new Error(`沒有名為 ${name} 的工具`)
      const result = await mcp.call(tool.upstream, { query, country: 'TW', search_lang: 'zh-hant', ui_lang: 'zh-TW', count: 5 }, runSignal)
      if (result.isError) throw new Error(result.content?.map(c => c.text).join(' ').slice(0, 200) || '搜尋服務回報錯誤')
      return digestResults(result.content)
    } }
  }
  // Memory summaries only use the model while no one is chatting; a new chat preempts them.
  let busy: 'chat' | 'summary' | null = null
  let summary: { abort: AbortController; done: Promise<void> } | null = null
  function characterFor(characterId: unknown) {
    if (typeof characterId !== 'string' || !store) throw new ServiceError('角色資料格式錯誤。', 400)
    const character = store.character(characterId)
    if (!character) throw new ServiceError('找不到此角色，請重新載入後再試。', 404)
    return character
  }
  return createServer(async (request, response) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('生成逾時，請重新生成。')), 180000)
    response.on('close', () => { if (!response.writableEnded) abort.abort() })
    request.on('aborted', () => abort.abort())
    try {
      // This is a loopback-only service. Reject cross-origin browser writes.
      const origin = request.headers.origin
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) throw new ServiceError('不允許此來源。', 403)
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const importRoute = /^\/api\/live2d\/import(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname)
      if (importRoute) {
        if (!store) throw new ServiceError('此服務未啟用資料保存。', 503)
        const token = importRoute[1]
        if (!token && request.method === 'POST') {
          if (request.headers['content-type'] !== 'application/zip' && request.headers['content-type'] !== 'application/octet-stream') throw new ServiceError('請上傳 ZIP 檔。', 415)
          json(response, 201, store.importZip(await readBytes(request, IMPORT_LIMITS.zipBytes))); return
        }
        if (token && request.method === 'POST') {
          if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError('請使用 JSON 格式。', 415)
          const body = await readBody(request, 4096)
          json(response, 201, { model: store.commitImport(token, body?.path, body?.name) }); return
        }
        if (token && request.method === 'DELETE') { store.discardImport(token); json(response, 200, { discarded: token }); return }
        json(response, 405, { error: '不支援此匯入操作。' }); return
      }
      const modelRoute = /^\/api\/live2d\/models(?:\/([^/]+))?$/.exec(url.pathname)
      if (modelRoute) {
        if (!store) throw new ServiceError('此服務未啟用資料保存。', 503)
        const id = modelRoute[1] === undefined ? undefined : decodeId(modelRoute[1])
        if (!id && request.method === 'GET') { json(response, 200, { models: store.listModels() }); return }
        if (!id && request.method === 'POST') {
          if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError('請使用 JSON 格式。', 415)
          const body = await readBody(request, 4096)
          json(response, 201, { model: store.addModel(body?.name, body?.entry) }); return
        }
        if (id && request.method === 'DELETE') { store.deleteModel(id); json(response, 200, { deleted: id }); return }
        json(response, 405, { error: '不支援此模型索引操作。' }); return
      }
      const assetPath = /^\/api\/assets(?:\/([^/]+)(\/file)?)?$/.exec(url.pathname)
      if (assetPath) {
        if (!store) throw new ServiceError('此服務未啟用資料保存。', 503)
        const [, rawId, file] = assetPath, assetId = rawId === undefined ? undefined : decodeId(rawId)
        if (assetId === undefined && request.method === 'GET') { json(response, 200, { assets: store.listAssets() }); return }
        if (assetId === undefined && request.method === 'POST') {
          if (request.headers['content-type'] !== 'application/octet-stream') throw new ServiceError('請以二進位檔案上傳素材。', 415)
          const asset = store.addAsset(url.searchParams.get('kind') ?? '', url.searchParams.get('name') ?? '', await readBytes(request, ASSET_MAX_BYTES))
          json(response, 201, { asset }); return
        }
        if (assetId !== undefined && file && request.method === 'GET') {
          const found = store.assetFile(assetId)
          if (!found) { json(response, 404, { error: '找不到此素材。' }); return }
          // Asset ids are never reused, so the bytes behind a URL never change.
          response.writeHead(200, { 'Content-Type': found.mime, 'Content-Length': found.bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" })
          response.end(found.bytes); return
        }
        if (assetId !== undefined && !file && request.method === 'DELETE') { store.deleteAsset(assetId); json(response, 200, { deleted: assetId }); return }
        json(response, 405, { error: '不支援此素材操作。' }); return
      }
      if (url.pathname === '/api/workspace') {
        if (!store) throw new ServiceError('此服務未啟用資料保存。', 503)
        if (request.method === 'GET') { json(response, 200, store.read()); return }
        if (request.method === 'PUT' || request.method === 'POST') {
          if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError('請使用 JSON 格式。', 415)
          const body = await readBody(request, 10 * 1024 * 1024)
          if (!body || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 || typeof body.writeId !== 'string' || !body.writeId.length || body.writeId.length > 100) throw new ServiceError('保存請求格式錯誤。', 400)
          try { assertWorkspace(body.snapshot) } catch { throw new ServiceError('保存資料格式或來源關聯不正確。', 400) }
          json(response, 200, { revision: store.save(body.baseRevision, body.writeId, body.snapshot) }); return
        }
        json(response, 405, { error: '不支援此保存操作。' }); return
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        // Voice and search availability are reported even when llama.cpp is down, so reading old replies aloud still works.
        const services = { busy: busy === 'chat', tts: !!options.ttsUrl, search: toolDefinitions(await searchTools(abort.signal)).length > 0 }
        try { json(response, 200, { ...await client.status(abort.signal), ...services }) }
        catch (error) { if (abort.signal.aborted) throw error; json(response, error instanceof ServiceError ? error.status : 503, { error: error instanceof Error ? error.message : '無法連接 llama.cpp。', ...services }) }
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/memory/summarize') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError('請使用 JSON 格式。', 415)
        const body = await readBody(request)
        if (!body || !validTranscript(body.messages, 200)) throw new ServiceError('記憶整理的對話格式錯誤。', 400)
        const character = characterFor(body.characterId)
        if (busy) throw new ServiceError('模型正忙，稍後再整理記憶。', 409)
        const controller = new AbortController()
        let release = () => {}
        busy = 'summary'; summary = { abort: controller, done: new Promise<void>(done => { release = done }) }
        try {
          const memories = await client.summarize(character.name, body.messages, character.memories.map(m => m.text), AbortSignal.any([abort.signal, controller.signal]))
          json(response, 200, { memories })
        } catch (error) {
          if (controller.signal.aborted) throw new ServiceError('模型開始回覆對話，記憶整理延後。', 409)
          throw error
        } finally { busy = null; summary = null; release() }
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/tts/voices') {
        if (!options.ttsUrl) throw new ServiceError('尚未設定本機 TTS 服務（TTS_URL）。', 503)
        let upstream: Response
        try { upstream = await fetch(new URL('/voices', options.ttsUrl), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) }) }
        catch { throw new ServiceError('無法連接本機 TTS 服務。', 503) }
        // Services without a voice list (any generic TTS) simply return none; the editor then shows a text field.
        if (upstream.status === 404) { json(response, 200, { voices: [], default: null }); return }
        const body = await upstream.json().catch(() => null) as { voices?: unknown; default?: unknown } | null
        const voices = Array.isArray(body?.voices) ? body.voices.filter((v): v is { id: string; label: string } => !!v && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 200 && typeof v.label === 'string' && v.label.length <= 200).slice(0, 500) : []
        if (!upstream.ok || !body) throw new ServiceError(`本機 TTS 服務回應錯誤（${upstream.status}）。`, 502)
        json(response, 200, { voices: voices.map(v => ({ id: v.id, label: v.label })), default: typeof body.default === 'string' && voices.some(v => v.id === body.default) ? body.default : null }); return
      }
      if (request.method === 'POST' && url.pathname === '/api/tts') {
        if (!options.ttsUrl) throw new ServiceError('尚未設定本機 TTS 服務（TTS_URL）。', 503)
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError('請使用 JSON 格式。', 415)
        const body = await readBody(request)
        if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new ServiceError('朗讀文字必須介於 1 到 4000 字。', 400)
        const character = characterFor(body.characterId)
        // The browser sends the voice it is about to hear (also for unsaved previews); fall back to the stored one.
        if (body.voice !== undefined && (typeof body.voice !== 'string' || body.voice.length > 200)) throw new ServiceError('聲音名稱格式錯誤。', 400)
        if (body.speed !== undefined && !(typeof body.speed === 'number' && Number.isFinite(body.speed) && body.speed >= 0.5 && body.speed <= 2)) throw new ServiceError('語速須介於 0.5 到 2。', 400)
        const voiceId = typeof body.voice === 'string' ? body.voice : character.voice.httpVoice, speed = typeof body.speed === 'number' ? body.speed : character.voice.rate
        let upstream: Response
        try {
          upstream = await fetch(options.ttsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: body.text, voice: voiceId, speed }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]) })
        } catch { throw new ServiceError('無法連接本機 TTS 服務。', 503) }
        const type = upstream.headers.get('content-type') ?? ''
        if (!upstream.ok || !type.startsWith('audio/')) {
          const detail = type.includes('json') ? await upstream.json().then((b: { error?: unknown }) => typeof b?.error === 'string' ? b.error.slice(0, 200) : '').catch(() => '') : ''
          throw new ServiceError(`本機 TTS 服務回應錯誤（${upstream.status}）${detail ? `：${detail}` : '。'}`, 502)
        }
        const audio = Buffer.from(await upstream.arrayBuffer())
        response.writeHead(200, { 'Content-Type': type, 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        response.end(audio); return
      }
      if (request.method !== 'POST' || url.pathname !== '/api/chat') { json(response, 404, { error: '找不到此 API。' }); return }
      if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError('請使用 JSON 格式。', 415)
      const body = await readBody(request)
      if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 400 || body.messages.some((m: ChatMessage) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) || body.messages.at(-1).role !== 'user') throw new ServiceError('對話格式錯誤，最後一則必須是使用者訊息。', 400)
      const maxTokens = body.maxTokens ?? 1024
      if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 2048) throw new ServiceError('生成上限必須介於 64 到 2048 tokens。', 400)
      let systemPrompt: string | undefined, search: SearchHandler | undefined
      if (body.characterId !== undefined) {
        const character = characterFor(body.characterId)
        search = await searchHandler(abort.signal)
        systemPrompt = character.systemPrompt + EXPRESSION_INSTRUCTION + (search ? SEARCH_INSTRUCTION : '') + (character.memoryEnabled ? memoryPrompt(character.memories) : '')
      }
      if (busy === 'summary' && summary) { summary.abort.abort(); await summary.done }
      if (busy) throw new ServiceError('模型正在處理另一個請求，請稍後重試。', 409)
      busy = 'chat'
      try {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
        response.flushHeaders()
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n') }, 15000)
        try {
          for await (const event of client.chat(body.messages, maxTokens, abort.signal, systemPrompt, systemPrompt !== undefined, search)) {
            if (response.destroyed) break
            response.write(`data: ${JSON.stringify(event)}\n\n`)
          }
        } catch (error) {
          if (!response.destroyed) response.write(`data: ${JSON.stringify({ type: 'error', message: abort.signal.aborted ? '生成逾時或已取消，已保留收到的內容。' : error instanceof Error ? error.message : '生成失敗，請重試。' })}\n\n`)
        } finally { clearInterval(heartbeat); response.end() }
      } finally { busy = null }
    } catch (error) {
      if (!response.destroyed) json(response, error instanceof StorageConflict ? 409 : error instanceof ServiceError || error instanceof StoreError ? error.status : 500, { error: error instanceof StorageConflict || error instanceof ServiceError || error instanceof StoreError ? error.message : '本機資料讀寫失敗，請確認儲存空間與存取權限後重試。' })
    } finally { clearTimeout(timer) }
  })
}
