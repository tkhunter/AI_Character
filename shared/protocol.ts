import type { ExpressionKey } from './characters.ts'
export type SearchSource = { title: string; url: string }
export type TokenSource = 'tokenizer' | 'estimate'
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ContextInfo = { promptTokens: number; source: TokenSource; droppedMessages: number; contextLimit: number }
export type ChatEvent =
  | { type: 'context'; context: ContextInfo }
  | { type: 'delta'; text: string }
  | { type: 'expression'; expression: ExpressionKey }
  | { type: 'search'; query: string }
  | { type: 'sources'; sources: SearchSource[] }
  | { type: 'tokens'; count: number; source: TokenSource }
  | { type: 'done'; count: number; source: TokenSource; finishReason: string; completionTokens?: number; promptTokens?: number }
  | { type: 'error'; message: string }
