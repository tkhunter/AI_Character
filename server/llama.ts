import { readSSE } from '../shared/sse.ts'
import type { ChatEvent, ChatMessage, SearchSource, TokenSource } from '../shared/protocol.ts'

/** Lets the model call search tools; results go back to it, sources go to the reader. */
export type SearchHandler = { tools: unknown[]; run: (name: string, query: string, signal: AbortSignal) => Promise<{ text: string; sources: SearchSource[] }> }
export const MAX_TOOL_ROUNDS = 2
import { DEFAULT_SYSTEM_PROMPT, takeExpression } from '../shared/characters.ts'

export const SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT
type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export class ServiceError extends Error { status: number; constructor(message: string, status = 502) { super(message); this.status = status } }

export class LlamaClient {
  baseUrl: string
  contextLimit: number
  constructor(baseUrl: string, contextLimit = 8192) { this.baseUrl = baseUrl.replace(/\/$/, ''); this.contextLimit = contextLimit }
  async request(path: string, payload?: unknown, signal?: AbortSignal, timeout = 12000) {
    let response: Response
    try {
      response = await fetch(this.baseUrl + path, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ServiceError('無法連接 llama.cpp，請確認本機服務已啟動。', 503)
    }
    if (!response.ok) {
      const detail = await response.text()
      throw new ServiceError(response.status === 400 ? '模型拒絕此請求，可能超出上下文或不支援參數。' : `llama.cpp 回應錯誤（${response.status}）。${detail.includes('loading') ? '模型正在載入，請稍後重試。' : ''}`, response.status === 503 ? 503 : 502)
    }
    return response
  }
  async status(signal?: AbortSignal) {
    await this.request('/health', undefined, signal, 4000)
    const models = await (await this.request('/v1/models', undefined, signal, 4000)).json() as { data?: { id?: string }[] }
    const rawModel = models.data?.[0]?.id ?? ''
    let contextSize = 4096
    try { const props = await (await this.request('/props', undefined, signal, 4000)).json() as { default_generation_settings?: { n_ctx?: number } }; contextSize = props.default_generation_settings?.n_ctx ?? 4096 } catch { /* Conservative fallback for older servers. */ }
    return { connected: true, model: rawModel.split(/[\\/]/).pop() || '本機模型', contextSize: Math.min(this.contextLimit, contextSize), endpoint: this.baseUrl }
  }
  async count(text: string, signal?: AbortSignal, parseSpecial = false): Promise<{ count: number; source: TokenSource }> {
    if (!text) return { count: 0, source: 'tokenizer' }
    try {
      const result = await (await this.request('/tokenize', { content: text, add_special: false, parse_special: parseSpecial }, signal, 4000)).json() as { tokens?: unknown[] }
      if (!Array.isArray(result.tokens)) throw new Error('Invalid tokenizer response')
      return { count: result.tokens.length, source: 'tokenizer' }
    } catch (error) {
      if (signal?.aborted) throw error
      return { count: parseSpecial ? Buffer.byteLength(text) : Math.ceil([...text].length / 1.5), source: 'estimate' }
    }
  }
  async promptCount(messages: PromptMessage[], signal: AbortSignal) {
    try {
      const result = await (await this.request('/apply-template', { messages, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } }, signal, 4000)).json() as { prompt?: string }
      if (typeof result.prompt !== 'string') throw new Error('Invalid template response')
      return await this.count(result.prompt, signal, true)
    } catch (error) {
      if (signal.aborted) throw error
      return { count: messages.reduce((sum, m) => sum + Buffer.byteLength(m.content) + 64, 64), source: 'estimate' as const }
    }
  }
  async prepare(messages: ChatMessage[], maxTokens: number, signal: AbortSignal, systemPrompt = SYSTEM_PROMPT) {
    const status = await this.status(signal)
    const contextLimit = status.contextSize
    const prepared: PromptMessage[] = [{ role: 'system', content: systemPrompt }, ...messages]
    let droppedMessages = 0
    let counted = await this.promptCount(prepared, signal)
    while (counted.count + maxTokens + 128 > contextLimit) {
      // Drop complete oldest turns, preserving the system prompt and newest user request.
      const nextUser = prepared.findIndex((m, index) => index > 1 && m.role === 'user')
      if (nextUser < 0) throw new ServiceError('這次輸入太長，無法放入模型上下文。請縮短訊息或降低生成上限。', 413)
      droppedMessages += nextUser - 1
      prepared.splice(1, nextUser - 1)
      counted = await this.promptCount(prepared, signal)
    }
    return { messages: prepared, context: { promptTokens: counted.count, source: counted.source, droppedMessages, contextLimit } }
  }
  async *chat(messages: ChatMessage[], maxTokens: number, signal: AbortSignal, systemPrompt = SYSTEM_PROMPT, expressions = false, search?: SearchHandler): AsyncGenerator<ChatEvent> {
    const prepared = await this.prepare(messages, maxTokens, signal, systemPrompt)
    yield { type: 'context', context: prepared.context }
    const conversation: Record<string, unknown>[] = [...prepared.messages]
    let text = '', finishReason = '', lastCount = 0
    let usage: { completion_tokens?: number; prompt_tokens?: number } = {}
    // While `head` is non-null the reply may still open with an expression tag, so nothing is shown yet.
    let head: string | null = null, trimLead = false
    for (let round = 0; ; round++) {
      // The last round withholds tools so the model has to answer with what it found.
      const offerTools = !!search && round < MAX_TOOL_ROUNDS
      const response = await this.request('/v1/chat/completions', {
        messages: conversation, stream: true, stream_options: { include_usage: true },
        max_tokens: maxTokens, temperature: 0.8, chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'deepseek',
        ...(offerTools ? { tools: search!.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
      }, signal, 180000)
      if (!response.body) throw new ServiceError('模型未提供串流內容。')
      let terminal = false, roundText = ''
      const separate = text.length > 0 && !text.endsWith('\n')
      head = expressions ? '' : null; trimLead = false
      const calls: { id: string; name: string; arguments: string }[] = []
      for await (const event of readSSE(response.body)) {
        if (signal.aborted) throw signal.reason
        if (event.data === '[DONE]') { terminal = true; break }
        const chunk = JSON.parse(event.data)
        if (chunk.error) throw new ServiceError('模型生成失敗，請重試。')
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        for (const call of choice?.delta?.tool_calls ?? []) {
          const slot = calls[call.index ?? 0] ??= { id: '', name: '', arguments: '' }
          if (call.id) slot.id = call.id
          if (call.function?.name) slot.name += call.function.name
          if (call.function?.arguments) slot.arguments += call.function.arguments
        }
        // reasoning_content is intentionally never forwarded or counted as visible dialogue.
        let delta = choice?.delta?.content
        if (typeof delta === 'string' && delta && head !== null) {
          head += delta
          const taken = takeExpression(head)
          if (taken.pending) continue
          head = null; delta = taken.text
          if (taken.expression) { yield { type: 'expression', expression: taken.expression }; trimLead = true }
        }
        if (typeof delta === 'string' && trimLead) { delta = delta.replace(/^\s+/, ''); if (delta) trimLead = false }
        if (typeof delta === 'string' && delta) {
          if (separate && !roundText) delta = '\n' + delta
          text += delta; roundText += delta
          yield { type: 'delta', text: delta }
          if (Date.now() - lastCount >= 700) {
            const counted = await this.count(text, signal)
            yield { type: 'tokens', ...counted }
            lastCount = Date.now()
          }
        }
      }
      if (!terminal) throw new ServiceError('模型串流意外中斷，已保留收到的內容，可重新生成。')
      const toolCalls = calls.filter(Boolean)
      if (!toolCalls.length || !offerTools) break
      if (head) { roundText += head; head = null }
      conversation.push({ role: 'assistant', content: roundText || null, tool_calls: toolCalls.map((c, i) => ({ id: c.id || `call_${round}_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) })
      for (const [i, c] of toolCalls.entries()) {
        let query = ''
        try { query = String(JSON.parse(c.arguments || '{}').query ?? '').trim().slice(0, 400) } catch { /* Reported to the model below. */ }
        let content = '缺少搜尋關鍵字，請提供 query。'
        if (query) {
          yield { type: 'search', query }
          try {
            const result = await search!.run(c.name, query, signal)
            content = result.text
            if (result.sources.length) yield { type: 'sources', sources: result.sources }
          } catch (error) {
            if (signal.aborted) throw error
            content = `搜尋失敗：${error instanceof Error ? error.message : '未知錯誤'}。請依照既有知識回答，並說明暫時查不到最新資料。`
          }
        }
        conversation.push({ role: 'tool', tool_call_id: c.id || `call_${round}_${i}`, content })
      }
    }
    // A reply shorter than any possible tag is plain dialogue.
    if (head) { text += head; yield { type: 'delta', text: head } }
    if (!text.trim()) throw new ServiceError('模型沒有產生可顯示的台詞，請重新生成。')
    const counted = await this.count(text, signal)
    yield { type: 'done', ...counted, finishReason: finishReason || 'stop', completionTokens: usage.completion_tokens, promptTokens: usage.prompt_tokens }
  }
  /** Distil a stretch of dialogue into a few new long-term memory notes. */
  async summarize(name: string, transcript: ChatMessage[], existing: string[], signal: AbortSignal) {
    const dialogue = transcript.map(m => `${m.role === 'user' ? '使用者' : name}：${m.content}`).join('\n').slice(-12000)
    const known = existing.length ? existing.map(m => `- ${m}`).join('\n') : '（尚無）'
    const response = await this.request('/v1/chat/completions', {
      messages: [
        { role: 'system', content: `你負責為角色「${name}」整理長期記憶。從對話中找出之後聊天值得記住的事實：使用者的名字、喜好、經歷、約定、重要事件，以及兩人關係的變化。已經記得的事不要重複；閒聊、客套與角色自己的設定不要記。輸出 JSON 字串陣列，最多 5 則，每則 60 字以內的繁體中文完整句子，以「使用者」稱呼對方。沒有新事項時輸出 []。只輸出 JSON。` },
        { role: 'user', content: `已經記得的事：\n${known}\n\n新的對話：\n${dialogue}` },
      ],
      stream: false, max_tokens: 400, temperature: 0.3, chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'deepseek',
    }, signal, 120000)
    const content = ((await response.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''
    return parseMemories(content, existing)
  }
}
export function parseMemories(content: string, existing: string[] = []) {
  const start = content.indexOf('['), end = content.lastIndexOf(']')
  if (start < 0 || end < start) return []
  let parsed: unknown
  try { parsed = JSON.parse(content.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const seen = new Set(existing.map(m => m.trim()))
  const result: string[] = []
  for (const item of parsed) {
    const text = typeof item === 'string' ? item.trim().slice(0, 120) : ''
    if (!text || seen.has(text)) continue
    seen.add(text); result.push(text)
    if (result.length >= 5) break
  }
  return result
}

