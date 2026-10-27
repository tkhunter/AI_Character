import type { Conversation, Saved } from '../src/chat/model.ts'
import { CHARACTER_LIMITS, EXPRESSIONS, characterProblem } from './characters.ts'
import type { Character } from './characters.ts'

export type Workspace = {
  schemaVersion: 3; activeId: string; characters: Character[]; conversations: Conversation[]; saved: Saved[]
  preferences: { threshold: number; speed: number; maxTokens: number; favoriteScope: 'all' | 'current'; favoriteQuery: string; search: string
    voiceEnabled: boolean; voiceAuto: boolean; voiceEngine: 'browser' | 'http'
    /** Added later; missing means on. */
    voiceStream?: boolean; voiceSync?: boolean }
  panelPolicy: { dismissed: string[]; autoOpened: string[] }
}
export const defaultVoicePreferences = () => ({ voiceEnabled: true, voiceAuto: false, voiceEngine: 'browser' as const })
export type WorkspaceEnvelope = { revision: number; snapshot: Workspace | null }
type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown, max = 1000000): value is string => typeof value === 'string' && value.length <= max
const integer = (value: unknown, max = 10000000): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const id = (value: unknown): value is string => string(value, 100) && value.length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 50000 && value.every(id)
const expressionKeys = new Set<string>(EXPRESSIONS.map(e => e.key))
const bool = (value: unknown) => typeof value === 'boolean'
const ratio = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2
function validCharacter(c: RecordValue) {
  if (!object(c.expressions) || Object.entries(c.expressions).some(([key, asset]) => !expressionKeys.has(key) || !id(asset))) return false
  const v = c.voice
  if (!object(v) || !string(v.browserVoice, 200) || !string(v.httpVoice, 200) || !ratio(v.rate) || !ratio(v.pitch) || !bool(c.memoryEnabled) || !Array.isArray(c.memories)) return false
  const memoryIds = new Set<string>()
  for (const m of c.memories) {
    if (!object(m) || !id(m.id) || memoryIds.has(m.id) || !string(m.text, 300) || !['auto', 'manual'].includes(m.source as string) || !string(m.createdAt, 100)) return false
    memoryIds.add(m.id)
  }
  return true
}
function validMessage(value: unknown): value is RecordValue {
  if (!object(value) || !id(value.id) || !['user', 'assistant'].includes(value.role as string) || !string(value.text) || !integer(value.tokens) || !['tokenizer', 'estimate'].includes(value.source as string) || !['opening', 'model'].includes(value.origin as string) || !['complete', 'generating', 'stopped', 'error'].includes(value.status as string)) return false
  if (value.responseTo !== undefined && !id(value.responseTo)) return false
  if (value.error !== undefined && !string(value.error, 5000)) return false
  if (value.finishReason !== undefined && !string(value.finishReason, 100)) return false
  if (value.completionTokens !== undefined && !integer(value.completionTokens)) return false
  if (value.expression !== undefined && !expressionKeys.has(value.expression as string)) return false
  if (value.searches !== undefined && (!Array.isArray(value.searches) || value.searches.length > 10 || !value.searches.every(q => string(q, 400)))) return false
  if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.length > 20 || !value.sources.every(s => object(s) && string(s.title, 300) && string(s.url, 2000) && /^https?:\/\//.test(s.url)))) return false
  return true
}
/** Validate references as well as shape before touching the durable database. */
export function assertWorkspace(value: unknown): asserts value is Workspace {
  const invalid = () => { throw new Error('保存資料格式或來源關聯不正確。') }
  if (!object(value) || value.schemaVersion !== 3 || !Array.isArray(value.characters) || !value.characters.length || value.characters.length > 200 || !id(value.activeId) || !Array.isArray(value.conversations) || !value.conversations.length || value.conversations.length > 2000 || !Array.isArray(value.saved) || value.saved.length > 50000 || !object(value.preferences) || !object(value.panelPolicy)) return invalid()
  const p = value.preferences
  if (![150, 300, 500].includes(p.threshold as number) || ![12, 32, 55].includes(p.speed as number) || ![256, 512, 1024, 2048].includes(p.maxTokens as number) || !['all', 'current'].includes(p.favoriteScope as string) || !string(p.favoriteQuery, 10000) || !string(p.search, 10000) || !bool(p.voiceEnabled) || !bool(p.voiceAuto) || !(p.voiceStream === undefined || bool(p.voiceStream)) || !(p.voiceSync === undefined || bool(p.voiceSync)) || !['browser', 'http'].includes(p.voiceEngine as string) || !strings(value.panelPolicy.dismissed) || !strings(value.panelPolicy.autoOpened)) return invalid()
  const characterIds = new Set<string>()
  for (const c of value.characters) {
    if (!object(c) || !id(c.id) || characterIds.has(c.id) || Object.keys(CHARACTER_LIMITS).some(key => !string(c[key], 100000)) || ![c.portraitAssetId, c.backgroundAssetId].every(a => a === null || id(a)) || !validCharacter(c) || characterProblem(c as unknown as Character)) return invalid()
    characterIds.add(c.id)
  }
  const conversations = new Map<string, Map<string, RecordValue>>()
  const allMessages = new Set<string>()
  for (const c of value.conversations) {
    if (!object(c) || !id(c.id) || conversations.has(c.id) || !characterIds.has(c.characterId as string) || !string(c.title, 500) || !string(c.time, 100) || !Array.isArray(c.messages) || !c.messages.length || !object(c.view) || !(c.backgroundAssetId === null || id(c.backgroundAssetId)) || !string(c.sceneLabel, 40) || !integer(c.memoryCursor, c.messages.length)) return invalid()
    const messages = new Map<string, RecordValue>()
    for (const m of c.messages) {
      if (!validMessage(m) || allMessages.has(m.id as string)) return invalid()
      messages.set(m.id as string, m); allMessages.add(m.id as string)
    }
    if (allMessages.size > 50000 || ![...messages.values()].some(m => m.role === 'assistant')) return invalid()
    for (const m of messages.values()) if (m.responseTo !== undefined && messages.get(m.responseTo as string)?.role !== 'user') return invalid()
    const v = c.view
    if (!integer(v.page, 100000) || !integer(v.visibleCount, 100000) || !string(v.draft, 12000) || ![null, 'long', 'saved'].includes(v.panel as null | string) || !strings(v.unread)) return invalid()
    for (const key of ['selectedMessageId', 'panelMessageId']) if (v[key] !== null && (!id(v[key]) || messages.get(v[key])?.role !== 'assistant')) return invalid()
    if (v.unread.some(key => messages.get(key)?.role !== 'assistant')) return invalid()
    if (v.context !== null && (!object(v.context) || !integer(v.context.promptTokens) || !integer(v.context.droppedMessages) || !integer(v.context.contextLimit) || !['tokenizer', 'estimate'].includes(v.context.source as string))) return invalid()
    conversations.set(c.id, messages)
  }
  if (!conversations.has(value.activeId)) return invalid()
  const favoriteIds = new Set<string>(), favoriteMessages = new Set<string>()
  for (const s of value.saved) {
    if (!object(s) || !id(s.id) || favoriteIds.has(s.id) || !id(s.conversationId) || !validMessage(s.message) || s.message.role !== 'assistant' || s.message.status === 'generating' || conversations.get(s.conversationId)?.get(s.message.id as string)?.role !== 'assistant' || favoriteMessages.has(s.message.id as string)) return invalid()
    favoriteIds.add(s.id); favoriteMessages.add(s.message.id as string)
  }
  for (const key of [...value.panelPolicy.dismissed, ...value.panelPolicy.autoOpened]) if (!allMessages.has(key)) return invalid()
}
