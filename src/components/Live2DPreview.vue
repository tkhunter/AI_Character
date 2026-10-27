<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Live2DStage from './Live2DStage.vue'
import { DEFAULT_MODEL, inspectInstallation, modelPath } from '../live2d/model'
const emit = defineEmits<{ close: [] }>()
const entry = ref(DEFAULT_MODEL), selected = ref(''), problem = ref(''), running = ref(false), checking = ref(false)
const fps = ref(0)
const checks = ref<{ url: string; ready: boolean; problem: string }[]>([])
const dialog = ref<HTMLElement>()
let previousFocus: HTMLElement | null = null
const ready = computed(() => checks.value.length === 3 && checks.value.every(check => check.ready))
let abort: AbortController | undefined
async function inspect() {
  abort?.abort(); abort = new AbortController(); const current = abort
  checking.value = true; problem.value = ''; selected.value = ''; running.value = false
  try {
    const result = await inspectInstallation(modelPath(entry.value.trim()), AbortSignal.any([current.signal, AbortSignal.timeout(10000)]))
    if (abort === current && !current.signal.aborted) checks.value = result
  }
  catch (error) { if (!current.signal.aborted) { problem.value = error instanceof Error ? error.message : '檢查失敗'; checks.value = [] } }
  finally { if (abort === current) checking.value = false }
}
function play() { try { selected.value = modelPath(entry.value.trim()); running.value = false; fps.value = 0; problem.value = '' } catch (error) { problem.value = (error as Error).message } }
function failed(message: string) { selected.value = ''; running.value = false; problem.value = message }
function edited() { abort?.abort(); checking.value = false; checks.value = []; selected.value = ''; running.value = false; problem.value = '' }
function close(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopImmediatePropagation(); emit('close') }
  if (event.key === 'Tab') {
    const controls = [...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled), input, a, summary')].filter(el => el.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
  }
}
onMounted(() => { previousFocus = document.activeElement as HTMLElement; dialog.value?.querySelector('button')?.focus(); void inspect(); window.addEventListener('keydown', close, true) })
onBeforeUnmount(() => { abort?.abort(); window.removeEventListener('keydown', close, true); if (previousFocus?.isConnected) previousFocus.focus() })
</script>
<template>
  <section ref="dialog" class="modal live2d-lab" role="dialog" aria-modal="true" aria-label="Live2D 本機試演">
    <header><div><span class="live2d-eyebrow">LIVE2D · B1</span><h2>讓角色，在這裡動起來。</h2></div><button class="icon-button" aria-label="關閉 Live2D 試演" @click="emit('close')">×</button></header>
    <p class="muted">獨立試演，不會更換角色或改寫對話。安裝完成後可在此驗證模型。</p>
    <div class="live2d-preview">
      <Live2DStage v-if="selected" :key="selected" :model-url="selected" @ready="running = true" @failed="failed" @metrics="fps = $event" />
      <div v-else class="live2d-empty"><span>✧</span><strong>等待第一位 Live2D 角色</strong><p>既有角色與聊天功能仍可正常使用。</p></div>
      <span v-if="selected" class="live2d-indicator" role="status">{{ running ? `模型已載入 · ${fps ? `${fps} FPS` : '30 FPS 目標'}` : '正在載入模型…' }}</span>
    </div>
    <label class="live2d-path">模型入口<input v-model="entry" aria-label="Live2D 模型入口" spellcheck="false" @input="edited" /></label>
    <div class="live2d-actions"><button :disabled="checking" @click="inspect">{{ checking ? '檢查中…' : '檢查本機安裝' }}</button><button :disabled="!ready || !!selected" @click="play">載入試演</button><button v-if="selected" @click="selected = ''; running = false">停止試演</button></div>
    <p v-if="problem" class="live2d-error" role="alert">{{ problem }}</p>
    <ul v-if="checks.length" class="live2d-checks"><li v-for="check in checks" :key="check.url" :class="{ missing: !check.ready }"><span>{{ check.ready ? '✓' : '○' }}</span><div>{{ check.url.split('/').pop() }}<small v-if="!check.ready">{{ check.problem }}</small></div></li></ul>
    <details :open="!ready"><summary>第一次使用：免費模型與安裝方式</summary><ol><li>前往 <a href="https://www.live2d.com/en/sdk/download/web/" target="_blank" rel="noopener noreferrer">官方 Cubism SDK for Web</a>，自行閱讀並同意條款，下載後解壓。</li><li>在專案終端執行：<code>npm run live2d:prepare -- "SDK 解壓目錄"</code></li><li>回到此處按「檢查本機安裝」，載入 SDK 中的 Haru 範例。</li></ol><p>也可參考 <a href="https://www.live2d.com/en/learn/sample/" target="_blank" rel="noopener noreferrer">官方免費模型頁</a>。每個模型仍有個別使用條件；本次只供本機自用。</p></details>
  </section>
</template>
