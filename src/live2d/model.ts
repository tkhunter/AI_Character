export const DEFAULT_MODEL = '/live2d/local/models/Haru/Haru.model3.json'
export const CORE_URL = '/live2d/local/core/live2dcubismcore.js'
export const RUNTIME_URL = '/live2d/local/runtime/adapter.js'
const ORIGIN = 'http://local.invalid'

export function modelPath(value: string) {
  if (!value.startsWith('/live2d/local/models/') || /[\\?#\u0000-\u001f]/.test(value)) throw new Error('請使用本機 /live2d/local/models/ 下的 model3.json。')
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { throw new Error('模型路徑編碼不正確。') }
  if (decoded.includes('%') || decoded.split('/').some(part => part === '..' || part === '.') || /[\\?#\u0000-\u001f]/.test(decoded)) throw new Error('模型路徑不可包含上層目錄或特殊路徑。')
  if (!decoded.endsWith('.model3.json')) throw new Error('請選擇 model3.json 匯出檔。')
  return new URL(value, ORIGIN).pathname
}
export function resourcePath(entry: string, reference: string) {
  modelPath(entry)
  if (!reference || /[\\?#\u0000-\u001f]/.test(reference) || reference.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(reference)) throw new Error('模型只能引用同一模型目錄內的相對素材。')
  let decoded: string
  try { decoded = decodeURIComponent(reference) } catch { throw new Error('素材路徑編碼不正確。') }
  if (decoded.includes('%') || decoded.split('/').includes('..') || /[\\?#\u0000-\u001f]/.test(decoded)) throw new Error('素材路徑不可離開模型目錄。')
  const directory = new URL('.', new URL(entry, ORIGIN))
  const result = new URL(reference, directory)
  if (result.origin !== ORIGIN || !result.pathname.startsWith(directory.pathname)) throw new Error('素材來源不正確。')
  return result.pathname
}
/** Display/reference name for a model3.json motion group whose name is the empty string. */
export const UNNAMED_GROUP = '未分組'
export type ModelExpression = { name: string; file: string }
export type ModelMotion = { file: string; fadeIn?: number; fadeOut?: number }
export type ModelManifest = { moc: string; textures: string[]; physics?: string; pose?: string; expressions: ModelExpression[]; motions: Record<string, ModelMotion[]> }
/** Optional exp3/motion3 lists: references must stay in the package; the counts are bounded. */
function performances(entry: string, expressions: unknown, motions: unknown) {
  const parsedExpressions: ModelExpression[] = [], parsedMotions: Record<string, ModelMotion[]> = {}
  if (expressions !== undefined) {
    if (!Array.isArray(expressions) || expressions.length > 64) throw new Error('表情清單格式不正確或數量過多。')
    for (const e of expressions as { Name?: unknown; File?: unknown }[]) {
      if (!e || typeof e.Name !== 'string' || !e.Name || e.Name.length > 100 || typeof e.File !== 'string' || !e.File.endsWith('.exp3.json')) throw new Error('表情需要名稱與 exp3.json 檔案。')
      if (parsedExpressions.some(x => x.name === e.Name)) throw new Error(`表情名稱重複：${e.Name}`)
      parsedExpressions.push({ name: e.Name, file: resourcePath(entry, e.File) })
    }
  }
  if (motions !== undefined) {
    if (!motions || typeof motions !== 'object' || Array.isArray(motions)) throw new Error('動作清單格式不正確。')
    let total = 0
    for (const [rawGroup, list] of Object.entries(motions)) {
      // Cubism allows an unnamed group (e.g. the official Mao); give it a name so "Group:index" references work.
      let group = rawGroup
      if (group === '') { group = UNNAMED_GROUP; for (let n = 2; Object.hasOwn(motions, group); n++) group = `${UNNAMED_GROUP}${n}` }
      if (group.length > 100 || group.includes(':') || !Array.isArray(list)) throw new Error(`動作群組格式不正確：${rawGroup || '（未命名）'}`)
      parsedMotions[group] = (list as { File?: unknown; FadeInTime?: unknown; FadeOutTime?: unknown }[]).map(m => {
        if (!m || typeof m.File !== 'string' || !m.File.endsWith('.motion3.json')) throw new Error('動作需要 motion3.json 檔案。')
        if (++total > 128) throw new Error('動作數量過多。')
        const fade = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10 ? v : undefined
        return { file: resourcePath(entry, m.File), ...(fade(m.FadeInTime) !== undefined ? { fadeIn: fade(m.FadeInTime) } : {}), ...(fade(m.FadeOutTime) !== undefined ? { fadeOut: fade(m.FadeOutTime) } : {}) }
      })
    }
  }
  return { expressions: parsedExpressions, motions: parsedMotions }
}
/** Names a model offers for mapping; also used by the editor without loading WebGL. */
export function modelCapabilities(manifest: ModelManifest) {
  return { expressions: manifest.expressions.map(e => e.name), motions: Object.fromEntries(Object.entries(manifest.motions).map(([group, list]) => [group, list.length])) as Record<string, number> }
}
export function parseManifest(entry: string, value: unknown): ModelManifest {
  if (!value || typeof value !== 'object') throw new Error('模型入口內容不正確。')
  const data = value as { Version?: number; FileReferences?: { Moc?: unknown; Textures?: unknown; Physics?: unknown; Pose?: unknown; Expressions?: unknown; Motions?: unknown } }
  const files = data.FileReferences
  if (data.Version !== 3 || !files || typeof files.Moc !== 'string' || !files.Moc.endsWith('.moc3') || !Array.isArray(files.Textures) || !files.Textures.length || files.Textures.length > 16 || files.Textures.some(t => typeof t !== 'string' || !t.toLowerCase().endsWith('.png'))) throw new Error('需要 Cubism 3+ 匯出模型、moc3 與 PNG 貼圖。')
  if (files.Physics !== undefined && (typeof files.Physics !== 'string' || !files.Physics.endsWith('.physics3.json'))) throw new Error('物理設定檔格式不正確。')
  if (files.Pose !== undefined && (typeof files.Pose !== 'string' || !files.Pose.endsWith('.pose3.json'))) throw new Error('姿勢設定檔格式不正確。')
  return { moc: resourcePath(entry, files.Moc), textures: files.Textures.map(t => resourcePath(entry, t as string)), ...(typeof files.Physics === 'string' ? { physics: resourcePath(entry, files.Physics) } : {}), ...(typeof files.Pose === 'string' ? { pose: resourcePath(entry, files.Pose) } : {}), ...performances(entry, files.Expressions, files.Motions) }
}
export async function localFile(path: string, signal: AbortSignal, request: typeof fetch = fetch) {
  const response = await request(path, { signal, cache: 'no-cache' })
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error(`尚未安裝或找不到檔案：${path}`)
  return response
}
export async function inspectInstallation(entry: string, signal: AbortSignal, request: typeof fetch = fetch) {
  const path = modelPath(entry)
  const checked = await Promise.all([CORE_URL, RUNTIME_URL, path].map(async url => {
    try {
      const response = await localFile(url, signal, request)
      if (url === path) parseManifest(path, await response.json())
      else if (!/javascript|ecmascript/.test(response.headers.get('content-type') ?? '')) throw new Error(`檔案不是 JavaScript：${url}`)
      return { url, ready: true, problem: '' }
    } catch (error) { if (signal.aborted) throw error; return { url, ready: false, problem: error instanceof Error ? error.message : '無法讀取檔案' } }
  }))
  return checked
}
