<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { StagePresentation } from '../../shared/live2d'
import { createActorSlot, loadActor } from '../live2d/loader'
import type { LiveActor } from '../live2d/loader'
import { createDirector } from '../live2d/director'
import type { Act } from '../live2d/director'
const props = defineProps<{ modelUrl: string; view?: StagePresentation; act?: Act; mouth?: () => number }>()
const emit = defineEmits<{ ready: []; failed: [message: string]; metrics: [fps: number]; capabilities: [value: { expressions: string[]; motions: Record<string, number> }] }>()
const canvas = ref<HTMLCanvasElement>()
const slot = createActorSlot()
let frame = 0, previous = 0, observer: ResizeObserver | undefined, actor: LiveActor | null = null, closed = false
let lastDraw = 0, sampleStart = 0, samples = 0
// One director per loaded actor, so a replaced model never inherits the previous model's state.
let director: ReturnType<typeof createDirector> | null = null
function resize() {
  const el = canvas.value
  if (!el || !actor) return
  const bounds = el.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(1, bounds.width), 4096 / Math.max(1, bounds.height))
  const width = Math.max(1, Math.round(bounds.width * ratio)), height = Math.max(1, Math.round(bounds.height * ratio))
  el.width = width; el.height = height; actor.resize(width, height)
}
function tick(time: number) {
  if (closed) return
  if (document.hidden) { previous = time; lastDraw = 0; sampleStart = 0; samples = 0 }
  else if (time - previous >= 1000 / 30) {
    const delta = lastDraw ? Math.min((time - lastDraw) / 1000, 0.1) : 0.033
    previous = time - ((time - previous) % (1000 / 30)); lastDraw = time
    try { actor?.setMouth?.(props.mouth?.() ?? 0); actor?.frame(delta) } catch { fail('Live2D 繪製失敗，已切回靜態立繪。'); return }
    if (!sampleStart) { sampleStart = time; samples = 0 }
    else { samples++; if (time - sampleStart >= 1000) { emit('metrics', Math.round(samples * 1000 / (time - sampleStart))); sampleStart = time; samples = 0 } }
  }
  frame = requestAnimationFrame(tick)
}
function fail(message: string) { closed = true; director = null; cancelAnimationFrame(frame); observer?.disconnect(); slot.clear(); actor = null; emit('failed', message) }
function contextLost(event: Event) { event.preventDefault(); fail('繪圖資源已中斷，請重試載入模型。') }
watch(() => props.view, value => { if (value) actor?.configure?.(value) }, { deep: true })
watch(() => props.act, value => { if (value) director?.apply(value) }, { deep: true })
function look(event: PointerEvent) {
  if (!props.view?.gaze) return
  const bounds = canvas.value!.getBoundingClientRect()
  actor?.look?.((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2)
}
onMounted(async () => {
  try {
    actor = await slot.load(signal => loadActor(canvas.value!, props.modelUrl, signal))
    if (!actor || closed) return
    if (props.view && !actor.configure) throw new Error('本機 Live2D 執行器需更新，請執行 SDK 準備指令並加上 --runtime-only。')
    if (props.view) actor.configure?.(props.view)
    const live = actor
    if (live.setExpression && live.setIdleMotion && live.playMotion) director = createDirector({ setExpression: live.setExpression, setIdleMotion: live.setIdleMotion, playMotion: live.playMotion })
    if (props.act) director?.apply(props.act)
    const offered = live.capabilities?.()
    if (offered) emit('capabilities', offered)
    resize(); observer = new ResizeObserver(resize); observer.observe(canvas.value!)
    frame = requestAnimationFrame(tick); emit('ready')
  } catch (error) { if (!closed) fail(error instanceof Error ? error.message : '無法載入模型。') }
})
onBeforeUnmount(() => { closed = true; director = null; cancelAnimationFrame(frame); observer?.disconnect(); slot.clear(); actor = null })
</script>
<template><canvas ref="canvas" class="live2d-canvas" aria-label="Live2D 模型舞台" @webglcontextlost="contextLost" @pointermove="look" @pointerleave="actor?.look?.(0, 0)"></canvas></template>
