import { EXPRESSIONS } from './characters.ts'
import type { ExpressionKey } from './characters.ts'

/** What the stage is doing for the active conversation; each cue may play one whitelisted motion. */
export const STAGE_CUES = [
  { key: 'idle', label: '待機（循環）' }, { key: 'thinking', label: '生成中' }, { key: 'searching', label: '上網搜尋中' },
  { key: 'reply', label: '開始回覆' }, { key: 'stopped', label: '停止／失敗' },
] as const
export type StageCue = (typeof STAGE_CUES)[number]['key']
export type StagePresentation = {
  mode: 'portrait' | 'live2d'; modelId: string | null; scale: number; x: number; y: number; gaze: boolean
  /** Model expression name (exp3 Name) per chat expression; missing ones fall back to neutral, then to none. */
  expressionMap?: Partial<Record<ExpressionKey, string>>
  /** Motion reference per cue: "Group" (random entry) or "Group:index". Only these motions are ever played. */
  motionMap?: Partial<Record<StageCue, string>>
  /** Stage framing; missing means full body. Bust zooms by bustZoom around a focus point (0 = model centre, 1 = top). */
  framing?: Framing; bustZoom?: number; bustFocus?: number
}
export type Framing = 'full' | 'bust'
export const BUST_DEFAULTS = { zoom: 1.8, focus: 0.5 } as const
/** Resolved bust settings with defaults, shared by the Live2D adapter and image portraits. */
export function bustOf(view: StagePresentation) { return { zoom: view.bustZoom ?? BUST_DEFAULTS.zoom, focus: view.bustFocus ?? BUST_DEFAULTS.focus } }
export type Live2DModel = { id: string; name: string; entry: string; available: boolean; problem: string }
export const defaultPresentation = (): StagePresentation => ({ mode: 'portrait', modelId: null, scale: 1, x: 0, y: 0, gaze: false })
const MOTION_REF = /^([^:\u0000-\u001f]{1,100})(?::(\d{1,3}))?$/
export function parseMotionRef(value: string) {
  const match = MOTION_REF.exec(value)
  return match ? { group: match[1]!, index: match[2] === undefined ? null : Number(match[2]) } : null
}
function mapProblem(value: unknown, keys: readonly string[], valid: (v: string) => boolean) {
  if (value === undefined) return false
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true
  return Object.entries(value).some(([key, v]) => !keys.includes(key) || typeof v !== 'string' || !v || v.length > 100 || !valid(v))
}
export function presentationProblem(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '角色呈現設定不正確。'
  const p = value as StagePresentation
  if (!['portrait', 'live2d'].includes(p.mode) || !(p.modelId === null || (typeof p.modelId === 'string' && p.modelId.length > 0 && p.modelId.length <= 100))) return '角色呈現模式或模型編號不正確。'
  if (p.mode === 'live2d' && !p.modelId) return '請選擇 Live2D 模型。'
  if (typeof p.gaze !== 'boolean' || !Number.isFinite(p.scale) || p.scale < 0.5 || p.scale > 3 || !Number.isFinite(p.x) || Math.abs(p.x) > 1 || !Number.isFinite(p.y) || Math.abs(p.y) > 1) return '縮放須介於 0.5～3，位置須介於 -1～1。'
  if (mapProblem(p.expressionMap, EXPRESSIONS.map(e => e.key), () => true)) return 'Live2D 表情對應設定不正確。'
  if (p.framing !== undefined && p.framing !== 'full' && p.framing !== 'bust') return '取景設定不正確。'
  if ((p.bustZoom !== undefined && !(Number.isFinite(p.bustZoom) && p.bustZoom >= 1.2 && p.bustZoom <= 4)) || (p.bustFocus !== undefined && !(Number.isFinite(p.bustFocus) && p.bustFocus >= 0 && p.bustFocus <= 1))) return '上半身縮放須介於 1.2～4，焦點須介於 0～1。'
  if (mapProblem(p.motionMap, STAGE_CUES.map(c => c.key), v => !!parseMotionRef(v))) return 'Live2D 動作對應設定不正確。'
  return ''
}
