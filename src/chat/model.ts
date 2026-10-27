import type { ContextInfo, SearchSource, TokenSource } from '../../shared/protocol.ts'
import type { ExpressionKey } from '../../shared/characters.ts'
export type Message = {
  id: string; role: 'user' | 'assistant'; text: string; tokens: number
  source: TokenSource; origin: 'opening' | 'model'; status: 'complete' | 'generating' | 'stopped' | 'error'
  error?: string; responseTo?: string; finishReason?: string; completionTokens?: number; expression?: ExpressionKey
  /** Web searches the model ran for this reply, and the pages it was given. */
  searches?: string[]; sources?: SearchSource[]
}
export type ViewState = {
  selectedMessageId: string | null; page: number; visibleCount: number; draft: string
  panel: 'long' | 'saved' | null; panelMessageId: string | null; context: ContextInfo | null; unread: string[]
}
export type Conversation = {
  id: string; characterId: string; title: string; time: string; messages: Message[]; view: ViewState
  /** Per-conversation scene override; null / '' inherit the character's. */
  backgroundAssetId: string | null; sceneLabel: string
  /** Number of leading messages already distilled into long-term memory. */
  memoryCursor: number
}
export type Saved = { id: string; conversationId: string; message: Message }
export function createView(): ViewState { return { selectedMessageId: null, page: 0, visibleCount: 0, draft: '', panel: null, panelMessageId: null, context: null, unread: [] } }
const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' })
export function characters(text: string) { return Array.from(segmenter.segment(text), part => part.segment) }
export function splitDialogue(text: string) {
  const pages: string[] = []; let buffer = '', count = 0
  for (const char of characters(text)) {
    buffer += char; count++
    if ((count >= 75 && /[。！？\n]/.test(char)) || count >= 115) { pages.push(buffer); buffer = ''; count = 0 }
  }
  if (buffer || !pages.length) pages.push(buffer)
  return pages
}
export function messageStatus(message: Message) {
  if (message.origin === 'opening') return '角色開場'
  if (message.status === 'generating') return '正在生成'
  if (message.status === 'stopped') return '已停止 · 部分內容'
  if (message.status === 'error') return '生成失敗 · 部分內容'
  if (message.finishReason === 'length') return '已達上限 · 部分內容'
  return '回覆完成'
}
export function tokenDescription(message: Message) {
  return message.origin === 'opening' ? '角色開場台詞' : `${message.source === 'estimate' ? '約 ' : ''}${message.tokens} tokens · ${message.source === 'tokenizer' ? '台詞實際計數' : '估算'}`
}
