import type { SearchSource } from '../shared/protocol.ts'

type RpcResult = { result?: unknown; error?: { message?: string } }
/** Minimal MCP client over Streamable HTTP (JSON or SSE responses), enough for tools/list and tools/call. */
export class McpClient {
  url: string
  session: string | null = null
  initialized = false
  id = 0
  constructor(url: string) { this.url = url }
  async rpc(method: string, params: unknown, signal?: AbortSignal, timeout = 30000): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (this.session) headers['Mcp-Session-Id'] = this.session
    const id = ++this.id
    const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) })
    const session = response.headers.get('mcp-session-id')
    if (session) this.session = session
    if (!response.ok) throw new Error(`搜尋服務回應錯誤（${response.status}）。`)
    const text = await response.text()
    const messages: RpcResult[] = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
      : [JSON.parse(text)]
    const reply = messages.find(m => (m as { id?: number }).id === id) ?? messages.at(-1)
    if (!reply || reply.error) throw new Error(reply?.error?.message || '搜尋服務沒有回應。')
    return reply.result
  }
  async ensureInitialized(signal?: AbortSignal) {
    if (this.initialized) return
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'shiori', version: '1.0.0' } }, signal, 5000)
    // The initialized notification has no reply; stateless servers may ignore it.
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (this.session) headers['Mcp-Session-Id'] = this.session
    await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(5000) }).catch(() => {})
    this.initialized = true
  }
  async tools(signal?: AbortSignal) {
    await this.ensureInitialized(signal)
    return ((await this.rpc('tools/list', {}, signal, 5000)) as { tools?: { name: string }[] }).tools ?? []
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.ensureInitialized(signal)
    try { return await this.rpc('tools/call', { name, arguments: args }, signal) as { content?: { type: string; text?: string }[]; isError?: boolean } }
    catch (error) { this.initialized = false; this.session = null; throw error }
  }
}

/** Tools offered to the model: a small, simple schema works better with local models than the full Brave one. */
export const SEARCH_TOOLS = [
  { name: 'web_search', upstream: 'brave_web_search', description: '用網路搜尋即時或你不確定的資訊（天氣、價格、近期事件、人物、地點、作品資料等）。' },
  { name: 'news_search', upstream: 'brave_news_search', description: '搜尋最近的新聞報導。' },
] as const
export const toolDefinitions = (available: string[]) => SEARCH_TOOLS.filter(t => available.includes(t.upstream)).map(t => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: { type: 'object', properties: { query: { type: 'string', description: '搜尋關鍵字，盡量精簡' } }, required: ['query'] } },
}))
export const SEARCH_INSTRUCTION = '\n\n【上網】你可以使用 web_search 或 news_search 工具上網查資料。遇到即時資訊（今天的天氣、新聞、價格、營業時間、近期事件）或你不確定的事實時，先搜尋再回答，不要說自己不能上網。查到後用角色自己的口吻自然轉述重點，可以提到資料來源的網站名稱，不要貼出網址或原始資料。'

const strip = (value: unknown) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/&(quot|amp|lt|gt|#39);/g, m => ({ '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" })[m]!).trim() : ''
/** Turn MCP text content into compact results for the model plus clickable sources for the reader. */
export function digestResults(content: { type: string; text?: string }[] = [], limit = 5) {
  const sources: SearchSource[] = [], lines: string[] = []
  for (const item of content) {
    if (item.type !== 'text' || !item.text) continue
    let parsed: unknown
    try { parsed = JSON.parse(item.text) } catch { lines.push(item.text.slice(0, 600)); continue }
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = r as Record<string, unknown>
      const url = typeof record.url === 'string' && /^https?:\/\//.test(record.url) ? record.url : ''
      const title = strip(record.title).slice(0, 200)
      if (!url || !title || sources.length >= limit) continue
      const snippets = Array.isArray(record.extra_snippets) ? record.extra_snippets.slice(0, 1).map(strip) : []
      sources.push({ title, url })
      lines.push(`[${sources.length}] ${title}\n${[strip(record.description), ...snippets].filter(Boolean).join(' ').slice(0, 400)}\n來源：${new URL(url).hostname}`)
    }
  }
  return { sources, text: lines.join('\n\n').slice(0, 2500) || '沒有找到相關結果。' }
}
