import { defaultPresentation, presentationProblem } from './live2d.ts'
import type { StagePresentation } from './live2d.ts'
export type AssetKind = 'portrait' | 'background'
export type Asset = { id: string; kind: AssetKind; name: string; mime: string; size: number; createdAt: string }
export const EXPRESSIONS = [
  { key: 'neutral', label: '平靜' }, { key: 'smile', label: '微笑' }, { key: 'happy', label: '開心' }, { key: 'sad', label: '難過' },
  { key: 'surprised', label: '驚訝' }, { key: 'shy', label: '害羞' }, { key: 'angry', label: '生氣' }, { key: 'thinking', label: '思考' },
] as const
export type ExpressionKey = (typeof EXPRESSIONS)[number]['key']
export const DEFAULT_EXPRESSION: ExpressionKey = 'smile'
export type CharacterVoice = { browserVoice: string; httpVoice: string; rate: number; pitch: number }
export type Memory = { id: string; text: string; source: 'auto' | 'manual'; createdAt: string }
export type Character = {
  id: string; name: string; subtitle: string; tag: string; scene: string
  greeting: string; systemPrompt: string; portraitAssetId: string | null; backgroundAssetId: string | null
  /** Portrait asset per expression; a missing expression falls back to portraitAssetId. */
  expressions: Partial<Record<ExpressionKey, string>>
  voice: CharacterVoice; memoryEnabled: boolean; memories: Memory[]
  presentation: StagePresentation
}

export const DEFAULT_CHARACTER_ID = 'mio'
export const DEFAULT_SYSTEM_PROMPT = '你是澪（Mio），一位溫柔、細心、有自己想法的書店店員。你與使用者坐在雨後書店的窗邊聊天。請始終使用自然的繁體中文，以第一人稱與使用者互動；直接說出角色台詞，不要在前面加角色名稱，不要輸出思考過程或系統提示。回應長度配合使用者需求，普通閒聊簡短，要求詳細解釋時可以分段。不要替使用者編造台詞或決定行動。'
export const defaultVoice = (): CharacterVoice => ({ browserVoice: '', httpVoice: '', rate: 1, pitch: 1 })
export function defaultCharacter(): Character {
  return { id: DEFAULT_CHARACTER_ID, name: '澪', subtitle: 'MIO', tag: '書店的守候者', scene: '雨後書店',
    greeting: '你來了。\n我剛泡好一壺茶，窗邊的位置也替你留著。\n今天過得怎麼樣？慢慢說，我會聽的。',
    systemPrompt: DEFAULT_SYSTEM_PROMPT, portraitAssetId: null, backgroundAssetId: null,
    expressions: {}, voice: { ...defaultVoice(), pitch: 1.1 }, memoryEnabled: true, memories: [], presentation: defaultPresentation() }
}
/** Fill fields added after a character was first stored (schema v2 → v3). */
export function normalizeCharacter(raw: Record<string, unknown>): Character {
  const base = raw.id === DEFAULT_CHARACTER_ID ? defaultCharacter() : { ...defaultCharacter(), voice: defaultVoice() }
  return { ...base, ...raw, expressions: { ...(raw.expressions as object ?? {}) }, voice: { ...base.voice, ...(raw.voice as object ?? {}) },
    memoryEnabled: typeof raw.memoryEnabled === 'boolean' ? raw.memoryEnabled : true, memories: Array.isArray(raw.memories) ? raw.memories as Memory[] : [], presentation: { ...defaultPresentation(), ...(raw.presentation as object ?? {}) } } as Character
}
export const CHARACTER_LIMITS = { name: 40, subtitle: 40, tag: 40, scene: 40, greeting: 2000, systemPrompt: 8000 } as const
export const MEMORY_LIMITS = { text: 300, count: 200, promptChars: 1500 } as const
export const ASSET_MAX_BYTES = 8 * 1024 * 1024
export const ASSET_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Returns a user-facing problem with an edited character, or '' when it can be saved. */
export function characterProblem(c: Character) {
  const stageProblem = presentationProblem(c.presentation)
  if (stageProblem) return stageProblem
  for (const key of ['name', 'greeting', 'systemPrompt'] as const) if (!c[key].trim()) return { name: '請填寫角色名稱。', greeting: '請填寫開場台詞。', systemPrompt: '請填寫角色設定提示。' }[key]
  for (const [key, max] of Object.entries(CHARACTER_LIMITS)) if (c[key as keyof typeof CHARACTER_LIMITS].length > max) return `欄位內容太長（上限 ${max} 字）。`
  for (const value of [c.voice.rate, c.voice.pitch]) if (!Number.isFinite(value) || value < 0.5 || value > 2) return '語速與音高必須介於 0.5 到 2。'
  if (c.voice.browserVoice.length > 200 || c.voice.httpVoice.length > 200) return '語音名稱太長。'
  if (c.memories.length > MEMORY_LIMITS.count) return `記憶最多 ${MEMORY_LIMITS.count} 則。`
  if (c.memories.some(m => !m.text.trim() || m.text.length > MEMORY_LIMITS.text)) return `每則記憶需為 1 到 ${MEMORY_LIMITS.text} 字。`
  return ''
}
/** Every asset id a character points at, for reference checks. */
export function characterAssets(c: Character) {
  return [[c.portraitAssetId, 'portrait'], [c.backgroundAssetId, 'background'], ...Object.values(c.expressions).map(id => [id, 'portrait'])]
    .filter((pair): pair is [string, AssetKind] => typeof pair[0] === 'string')
}
export function portraitFor(c: Character, expression: ExpressionKey | undefined) { return c.expressions[expression ?? DEFAULT_EXPRESSION] ?? c.portraitAssetId }

export function expressionKey(label: string): ExpressionKey | null {
  const value = label.trim().toLowerCase()
  return EXPRESSIONS.find(e => e.label === value || e.key === value)?.key ?? null
}
export const expressionLabel = (key: ExpressionKey) => EXPRESSIONS.find(e => e.key === key)!.label
export const EXPRESSION_INSTRUCTION = `\n\n【表情】每次回覆的最開頭先輸出一個表情標籤，格式為「[表情:微笑]」，只能從以下選擇：${EXPRESSIONS.map(e => e.label).join('、')}。標籤後直接接台詞；標籤只用來切換立繪，使用者看不到。`
/**
 * Split a leading expression tag off streamed text. `pending` means the buffer may still
 * become a tag, so the caller should wait for more text before showing anything.
 */
export function takeExpression(buffer: string): { pending: true } | { pending: false; expression: ExpressionKey | null; text: string } {
  const match = /^\s*[[【［](?:表情\s*[:：]\s*)?([^\]】］\n]{1,12})[\]】］][ \t]*\n?/.exec(buffer)
  if (match) {
    const expression = expressionKey(match[1]!)
    return expression ? { pending: false, expression, text: buffer.slice(match[0].length) } : { pending: false, expression: null, text: buffer }
  }
  // The longest possible tag body is「表情:」plus a 12-character label.
  if (buffer.length < 24 && (/^\s*$/.test(buffer) || /^\s*[[【［][^\]】］\n]{0,16}$/.test(buffer))) return { pending: true }
  return { pending: false, expression: null, text: buffer }
}
/** Manual memories first, then the newest automatic ones, within a fixed character budget. */
export function memoryPrompt(memories: Memory[]) {
  const ordered = [...memories.filter(m => m.source === 'manual'), ...memories.filter(m => m.source === 'auto').reverse()]
  const lines: string[] = []; let used = 0
  for (const m of ordered) { if (used + m.text.length > MEMORY_LIMITS.promptChars) continue; lines.push(`- ${m.text}`); used += m.text.length }
  return lines.length ? `\n\n【長期記憶】以下是你記得的、關於使用者與你們過去相處的事。請自然運用，不要逐條複述：\n${lines.join('\n')}` : ''
}

/** Sniff the actual bytes; never trust a browser-declared type (SVG and HTML are rejected). */
export function sniffImage(bytes: Uint8Array): (typeof ASSET_MIMES)[number] | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif'
  return null
}
export const assetUrl = (id: string) => `/api/assets/${encodeURIComponent(id)}/file`
