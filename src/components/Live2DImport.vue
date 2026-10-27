<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Live2DModel } from '../../shared/live2d'

type Candidate = { path: string; name: string; ok: boolean; problems: string[]; missing: string[]; textures: number; expressions: string[]; motions: Record<string, number> }
type Report = { token: string; files: number; bytes: number; skipped: string[]; candidates: Candidate[] }
const props = defineProps<{ applyTarget?: string }>()
const emit = defineEmits<{ installed: [model: Live2DModel, apply: boolean] }>()
const report = ref<Report | null>(null), chosen = ref(''), name = ref(''), apply = ref(false)
const busy = ref<'' | 'upload' | 'install'>(''), problem = ref(''), fileInput = ref<HTMLInputElement>()
const candidate = computed(() => report.value?.candidates.find(c => c.path === chosen.value) ?? null)
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
const motionSummary = (m: Record<string, number>) => Object.entries(m).map(([g, n]) => `${g}×${n}`).join('、') || '無'

async function send(path: string, init: RequestInit) {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `匯入失敗（${response.status}）`)
  return body
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!/\.zip$/i.test(file.name)) { problem.value = '請選擇 .zip 檔。'; return }
  if (report.value) await discard()
  busy.value = 'upload'; problem.value = ''
  try {
    const result = await send('/api/live2d/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }) as Report
    report.value = result
    const first = result.candidates.find(c => c.ok) ?? result.candidates[0]!
    chosen.value = first.path
    name.value = file.name.replace(/\.zip$/i, '').slice(0, 100) || first.name
  } catch (error) { problem.value = error instanceof Error ? error.message : '匯入失敗。' }
  finally { busy.value = '' }
}
async function install() {
  if (!report.value || !candidate.value) return
  busy.value = 'install'; problem.value = ''
  try {
    const { model } = await send(`/api/live2d/import/${report.value.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: candidate.value.path, name: name.value }) })
    report.value = null
    emit('installed', model, apply.value)
  } catch (error) { problem.value = error instanceof Error ? error.message : '安裝失敗。' }
  finally { busy.value = '' }
}
async function discard() {
  const token = report.value?.token
  report.value = null; problem.value = ''
  if (token) await fetch(`/api/live2d/import/${token}`, { method: 'DELETE' }).catch(() => {})
}
</script>

<template>
  <section class="live2d-import" aria-label="匯入 Live2D 模型">
    <div class="import-head">
      <strong>匯入 ZIP 模型包</strong>
      <button type="button" class="upload-button" :class="{ busy: busy === 'upload' }" :disabled="!!busy" @click="fileInput?.click()">{{ busy === 'upload' ? '檢查中…' : '＋ 選擇 ZIP' }}</button>
      <input ref="fileInput" class="visually-hidden" type="file" accept=".zip,application/zip" tabindex="-1" aria-hidden="true" @change="upload" />
    </div>
    <small class="muted">需要 Cubism 匯出的執行用模型（model3.json、moc3、PNG 貼圖），例如官方範例模型。壓縮檔內不可有程式或網頁檔；上限 200 MB。</small>
    <p v-if="problem" class="form-problem" role="alert">{{ problem }}</p>
    <div v-if="report" class="import-report">
      <p class="muted">{{ report.files }} 個檔案、{{ size(report.bytes) }}<template v-if="report.skipped.length">；略過 {{ report.skipped.length }} 個非模型檔（{{ report.skipped.slice(0, 3).join('、') }}{{ report.skipped.length > 3 ? '…' : '' }}）</template></p>
      <div v-if="report.candidates.length > 1" class="import-choices" role="radiogroup" aria-label="選擇要安裝的模型">
        <label v-for="c in report.candidates" :key="c.path"><input v-model="chosen" type="radio" :value="c.path" :disabled="!c.ok" /> {{ c.path }}<small v-if="!c.ok">（無法安裝）</small></label>
      </div>
      <dl v-if="candidate" class="import-facts">
        <dt>入口</dt><dd><code>{{ candidate.path }}</code></dd>
        <dt>貼圖</dt><dd>{{ candidate.textures }} 張</dd>
        <dt>表情</dt><dd>{{ candidate.expressions.length ? candidate.expressions.join('、') : '無' }}</dd>
        <dt>動作</dt><dd>{{ motionSummary(candidate.motions) }}</dd>
      </dl>
      <ul v-if="candidate?.problems.length" class="import-problems" role="alert"><li v-for="p in candidate.problems" :key="p">{{ p }}</li></ul>
      <p v-if="candidate?.missing.length" class="import-warning">缺少 {{ candidate.missing.length }} 個選用檔案（{{ candidate.missing.slice(0, 3).join('、') }}{{ candidate.missing.length > 3 ? '…' : '' }}），對應的表情或動作將無法使用。</p>
      <div class="form-grid">
        <label>模型名稱<input v-model="name" maxlength="100" aria-label="匯入模型名稱" /></label>
        <label v-if="props.applyTarget" class="toggle"><input v-model="apply" type="checkbox" /> 安裝後套用到「{{ props.applyTarget }}」（之後請按保存變更）</label>
      </div>
      <div class="form-actions"><button type="button" class="primary" :disabled="!!busy || !candidate?.ok || !name.trim()" @click="install">{{ busy === 'install' ? '安裝中…' : '安裝模型' }}</button><button type="button" :disabled="!!busy" @click="discard">取消</button></div>
    </div>
  </section>
</template>
