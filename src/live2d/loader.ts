import { CORE_URL, RUNTIME_URL, localFile, modelPath, parseManifest } from './model.ts'
import type { StagePresentation } from '../../shared/live2d.ts'
import type { Performer } from './director.ts'
export type LiveActor = { frame: (seconds: number) => void; resize: (width: number, height: number) => void; release: () => void; configure?: (view: StagePresentation) => void; look?: (x: number, y: number) => void }
  & Partial<Performer> & { capabilities?: () => { expressions: string[]; motions: Record<string, number> }; setMouth?: (value: number) => void }
export type LiveRuntime = { createActor: (canvas: HTMLCanvasElement, entry: string, signal: AbortSignal) => Promise<LiveActor> }
let corePromise: Promise<void> | null = null
async function core(signal: AbortSignal) {
  if ('Live2DCubismCore' in window) return
  await localFile(CORE_URL, signal)
  corePromise ??= new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script')
    let settled = false
    const timer = setTimeout(() => finish(new Error('Core 載入逾時，請重新整理後重試。')), 12000)
    function finish(error?: Error) { if (settled) return; settled = true; clearTimeout(timer); tag.onload = null; tag.onerror = null; if (error) { tag.remove(); corePromise = null; reject(error) } else resolve() }
    tag.src = CORE_URL
    tag.onload = () => finish('Live2DCubismCore' in window ? undefined : new Error('Core 檔案未提供 Cubism 執行介面。'))
    tag.onerror = () => finish(new Error('無法載入 Cubism Core，請執行本機準備指令。'))
    document.head.append(tag)
  })
  await corePromise
  signal.throwIfAborted()
}
export async function loadActor(canvas: HTMLCanvasElement, entry: string, signal: AbortSignal): Promise<LiveActor> {
  const deadline = new AbortController()
  signal = AbortSignal.any([signal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(), 30000)
  try {
    const path = modelPath(entry)
    const model = await localFile(path, signal)
    parseManifest(path, await model.json())
    await core(signal)
    await localFile(RUNTIME_URL, signal)
    // A same-origin absolute URL keeps Vite from rewriting public assets as source imports.
    const runtimeUrl = new URL(RUNTIME_URL, window.location.origin).href
    const runtime = await import(/* @vite-ignore */ runtimeUrl) as LiveRuntime
    signal.throwIfAborted()
    if (typeof runtime.createActor !== 'function') throw new Error('Live2D 執行器版本不相容，請重新準備 SDK。')
    const actor = await runtime.createActor(canvas, path, signal)
    if (signal.aborted) { actor.release(); signal.throwIfAborted() }
    return actor
  } catch (error) {
    if (deadline.signal.aborted) throw new Error('模型載入逾時，請確認素材完整後重試。')
    throw error
  } finally { clearTimeout(timer) }
}
/** Switching/unmounting releases late results too; old requests can never replace the active actor. */
export function createActorSlot() {
  let ticket = 0, abort: AbortController | undefined, actor: LiveActor | undefined
  function clear() { ticket++; abort?.abort(); abort = undefined; actor?.release(); actor = undefined }
  async function load(factory: (signal: AbortSignal) => Promise<LiveActor>) {
    clear(); const mine = ticket; const controller = new AbortController(); abort = controller
    const loaded = await factory(controller.signal)
    if (mine !== ticket || controller.signal.aborted) { loaded.release(); return null }
    actor = loaded; return loaded
  }
  return { load, clear }
}
