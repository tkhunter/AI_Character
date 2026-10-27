<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { CHARACTER_LIMITS, EXPRESSIONS, MEMORY_LIMITS, assetUrl, expressionLabel } from '../../shared/characters'
import type { Asset, AssetKind, Character } from '../../shared/characters'
import type { VoiceEngine } from '../chat/voice'
import { useModelCatalog } from '../live2d/catalog'
import Live2DImport from './Live2DImport.vue'
import type { Live2DModel } from '../../shared/live2d'
import Live2DStage from './Live2DStage.vue'
import { BUST_DEFAULTS, STAGE_CUES, bustOf, defaultPresentation } from '../../shared/live2d'
import type { StageCue } from '../../shared/live2d'
import { localFile, modelCapabilities, modelPath, parseManifest } from '../live2d/model'
import { autoMapping } from '../live2d/director'
import type { Act } from '../live2d/director'
import type { ExpressionKey } from '../../shared/characters'

const props = defineProps<{
  characters: Character[]; assets: Asset[]; assetsStatus: 'idle' | 'loading' | 'ready' | 'error'; assetError: string
  usage: Record<string, number>; activeCharacterId: string
  saveCharacter: (draft: Character) => string; deleteCharacter: (id: string) => string; newCharacter: () => Character
  uploadAsset: (file: File, kind: AssetKind) => Promise<Asset | null>; deleteAsset: (id: string) => Promise<boolean>; loadAssets: () => Promise<void>
  initialTab: 'characters' | 'assets' | 'memories'; activeConversationId: string
  /** Conversation titles using each background as their scene. */
  sceneUsage: Record<string, string[]>
  voices: { uri: string; name: string; lang: string }[]; voiceSupported: boolean; ttsAvailable: boolean; voiceEngine: VoiceEngine
  previewVoice: (id: string, text: string, character: Character, engine: VoiceEngine) => Promise<boolean>
  addMemory: (characterId: string, text: string) => string; updateMemory: (characterId: string, memoryId: string, text: string) => string
  deleteMemory: (characterId: string, memoryId: string) => void; setMemoryEnabled: (characterId: string, enabled: boolean) => void
  summarizeNow: (conversationId: string) => Promise<number>; memoryStatus: 'idle' | 'working' | 'error'; memoryError: string
}>()
// Voice list from the local TTS service (e.g. Kokoro); generic services without one keep a free-text field.
const ttsVoices = ref<{ id: string; label: string }[]>([]), ttsDefault = ref<string | null>(null), ttsVoicesProblem = ref('')
async function loadTtsVoices() {
  ttsVoicesProblem.value = ''
  try {
    const response = await fetch('/api/tts/voices', { signal: AbortSignal.timeout(8000) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || '無法讀取 TTS 聲音清單。')
    ttsVoices.value = body.voices; ttsDefault.value = body.default
  } catch (error) { ttsVoices.value = []; ttsVoicesProblem.value = error instanceof Error ? error.message : '無法讀取 TTS 聲音清單。' }
}
watch(() => props.ttsAvailable, available => { if (available) void loadTtsVoices() }, { immediate: true })
const clone = (c: Character): Character => JSON.parse(JSON.stringify(c))
// Memories change outside the form (automatic summaries), so they never make the form dirty.
const comparable = (c: Character) => JSON.stringify({ ...c, memories: [] })
const emit = defineEmits<{ close: []; start: [characterId: string] }>()
const tab = ref(props.initialTab)
const selectedId = ref(props.activeCharacterId)
const draft = ref<Character>(clone(props.characters.find(c => c.id === selectedId.value) ?? props.characters[0]!))
const problem = ref(''), uploadKind = ref<AssetKind>('portrait'), uploading = ref(false)
const { models, problem: modelProblem, loading: modelsLoading, load: loadModels, register: registerModel, remove: removeModel } = useModelCatalog()
const modelName = ref(''), modelEntry = ref('/live2d/local/models/Haru/Haru.model3.json'), modelBusy = ref(false), previewLive = ref(false), previewError = ref('')
const previewModel = computed(() => models.value.find(m => m.id === draft.value.presentation.modelId))
// Separate sources compare by value, so editing other presentation fields keeps the preview open.
watch([() => draft.value.id, () => draft.value.presentation.modelId, () => draft.value.presentation.mode], () => { previewLive.value = false; previewError.value = '' })
// Expression/motion names come from the model3.json manifest, so mapping works without loading WebGL.
const modelCaps = ref<{ expressions: string[]; motions: Record<string, number> } | null>(null), capsProblem = ref('')
let capsTicket = 0
watch(() => previewModel.value?.entry, async entry => {
  const ticket = ++capsTicket
  modelCaps.value = null; capsProblem.value = ''
  if (!entry) return
  try {
    const path = modelPath(entry), signal = AbortSignal.timeout(10000)
    const caps = modelCapabilities(parseManifest(path, await (await localFile(path, signal)).json()))
    if (ticket === capsTicket) modelCaps.value = caps
  } catch (error) { if (ticket === capsTicket) capsProblem.value = error instanceof Error ? error.message : '無法讀取模型表情與動作。' }
}, { immediate: true })
const motionOptions = computed(() => Object.entries(modelCaps.value?.motions ?? {}).flatMap(([group, count]) => [
  { value: group, label: `${group}（隨機 ${count} 個）` }, ...Array.from({ length: count }, (_, i) => ({ value: `${group}:${i}`, label: `${group} #${i + 1}` })),
]))
function setBust(key: 'bustZoom' | 'bustFocus', value: number) { draft.value.presentation[key] = value }
function setMapped(kind: 'expressionMap' | 'motionMap', key: string, value: string) {
  const map = { ...(draft.value.presentation[kind] ?? {}) } as Record<string, string>
  if (value) map[key] = value; else delete map[key]
  draft.value.presentation[kind] = map
}
function suggestMapping() {
  if (!modelCaps.value) return
  Object.assign(draft.value.presentation, autoMapping(modelCaps.value))
}
// The preview has its own act: trying a cue goes through idle first so the director sees a live change.
const previewAct = ref<Act>({ conversationId: 'preview', messageId: 'preview', cue: 'idle', expression: null, idleMotion: null, cueMotion: null })
watch(() => draft.value.presentation, view => { previewAct.value = { ...previewAct.value, idleMotion: view.motionMap?.idle ?? null } }, { deep: true, immediate: true })
function tryExpression(key: ExpressionKey) { previewAct.value = { ...previewAct.value, expression: draft.value.presentation.expressionMap?.[key] ?? draft.value.presentation.expressionMap?.neutral ?? null } }
async function tryCue(cue: StageCue) {
  previewAct.value = { ...previewAct.value, cue: 'idle', cueMotion: null }
  await nextTick()
  previewAct.value = { ...previewAct.value, cue, cueMotion: cue === 'idle' ? null : draft.value.presentation.motionMap?.[cue] ?? null }
}
const modelUsers = (id: string) => props.characters.filter(c => c.presentation.modelId === id).map(c => c.name)
async function registerLocalModel() { modelBusy.value = true; if (await registerModel(modelName.value, modelEntry.value.trim())) modelName.value = ''; modelBusy.value = false }
/** A freshly imported model can be bound to the character being edited right away. */
async function onImported(model: Live2DModel, apply: boolean) {
  await loadModels()
  // Applying changes the character form, so show it; the user still confirms with 保存變更.
  if (apply) { draft.value.presentation.mode = 'live2d'; draft.value.presentation.modelId = model.id; tab.value = 'characters' }
}
async function forgetModel(id: string) { modelBusy.value = true; await removeModel(id); modelBusy.value = false }
const isNew = computed(() => !props.characters.some(c => c.id === draft.value.id))
const stored = computed(() => props.characters.find(c => c.id === draft.value.id))
const dirty = computed(() => !stored.value || comparable(stored.value) !== comparable(draft.value))
const memoryCharacterId = ref(props.activeCharacterId), newMemory = ref(''), memoryProblem = ref('')
const editing = ref<{ id: string; text: string } | null>(null)
const memoryCharacter = computed(() => props.characters.find(c => c.id === memoryCharacterId.value) ?? props.characters[0]!)
const memories = computed(() => [...memoryCharacter.value.memories].reverse())
function setExpression(key: string, value: string | null) { if (value) draft.value.expressions[key as keyof Character['expressions']] = value; else delete draft.value.expressions[key as keyof Character['expressions']] }
function preview() { void props.previewVoice('preview', draft.value.greeting, clone(draft.value), props.voiceEngine === 'http' && props.ttsAvailable ? 'http' : 'browser') }
/** Picking a local TTS voice plays a short sample with it right away, so voices can be compared. */
function sampleTtsVoice() { if (props.ttsAvailable) void props.previewVoice('preview', [...draft.value.greeting].slice(0, 40).join('') || '你好，很高興認識你。', clone(draft.value), 'http') }
const voiceUnsaved = computed(() => !!stored.value && JSON.stringify(stored.value.voice) !== JSON.stringify(draft.value.voice))
function add() { memoryProblem.value = props.addMemory(memoryCharacter.value.id, newMemory.value); if (!memoryProblem.value) newMemory.value = '' }
function commitEdit() { if (!editing.value) return; memoryProblem.value = props.updateMemory(memoryCharacter.value.id, editing.value.id, editing.value.text); if (!memoryProblem.value) editing.value = null }
function forget(id: string) { if (confirm('確定要刪除這則記憶嗎？')) props.deleteMemory(memoryCharacter.value.id, id) }
const when = (iso: string) => new Date(iso).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
const portraits = computed(() => props.assets.filter(a => a.kind === 'portrait'))
const backgrounds = computed(() => props.assets.filter(a => a.kind === 'background'))
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
/** Every place an asset is used: default portrait, expression portraits, character background, conversation scenes. */
function uses(asset: Asset) {
  const found: string[] = []
  for (const c of props.characters) {
    if (c.portraitAssetId === asset.id) found.push(`${c.name} · 預設立繪`)
    for (const e of EXPRESSIONS) if (c.expressions[e.key] === asset.id) found.push(`${c.name} · ${expressionLabel(e.key)}`)
    if (c.backgroundAssetId === asset.id) found.push(`${c.name} · 預設背景`)
  }
  for (const title of props.sceneUsage[asset.id] ?? []) found.push(`場景 · ${title}`)
  return found
}
const date = (iso: string) => new Date(iso).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' })
const assetFilter = ref<'all' | AssetKind | 'unused'>('all'), assetQuery = ref(''), assetSort = ref<'newest' | 'name' | 'size'>('newest')
const fileInput = ref<HTMLInputElement>()
const filters = computed(() => [
  { key: 'all' as const, label: '全部', count: props.assets.length },
  { key: 'portrait' as const, label: '角色立繪', count: props.assets.filter(a => a.kind === 'portrait').length },
  { key: 'background' as const, label: '場景背景', count: props.assets.filter(a => a.kind === 'background').length },
  { key: 'unused' as const, label: '未使用', count: props.assets.filter(a => !uses(a).length).length },
])
const visibleAssets = computed(() => {
  const q = assetQuery.value.trim().toLocaleLowerCase()
  const list = props.assets.filter(a => (assetFilter.value !== 'unused' || !uses(a).length) && (!q || a.name.toLocaleLowerCase().includes(q)))
  const order = { newest: (a: Asset, b: Asset) => b.createdAt.localeCompare(a.createdAt), name: (a: Asset, b: Asset) => a.name.localeCompare(b.name, 'zh-Hant'), size: (a: Asset, b: Asset) => b.size - a.size }[assetSort.value]
  return [...list].sort(order)
})
/** Portraits are grouped by the character that uses them; backgrounds by where they are used. */
const assetGroups = computed(() => (['portrait', 'background'] as const)
  .filter(kind => assetFilter.value === 'all' || assetFilter.value === 'unused' || assetFilter.value === kind)
  .map(kind => {
    const items = visibleAssets.value.filter(a => a.kind === kind)
    const buckets: { key: string; title: string; items: Asset[] }[] = []
    if (kind === 'portrait') {
      for (const c of props.characters) {
        const mine = items.filter(a => c.portraitAssetId === a.id || Object.values(c.expressions).includes(a.id))
        if (mine.length) buckets.push({ key: c.id, title: c.name, items: mine })
      }
      const unused = items.filter(a => !buckets.some(b => b.items.includes(a)))
      if (unused.length) buckets.push({ key: 'unused', title: '尚未使用', items: unused })
    } else {
      const used = items.filter(a => uses(a).length), unused = items.filter(a => !uses(a).length)
      if (used.length) buckets.push({ key: 'used', title: '使用中', items: used })
      if (unused.length) buckets.push({ key: 'unused', title: '尚未使用', items: unused })
    }
    return { kind, title: kind === 'portrait' ? '角色立繪' : '場景背景', short: kind === 'portrait' ? '立繪' : '背景',
      hint: kind === 'portrait' ? '依使用的角色分組；同一張可以同時是多位角色的立繪或表情。' : '角色預設背景與對話場景都從這裡選。',
      total: props.assets.filter(a => a.kind === kind).length, buckets }
  }))
function pick(kind: AssetKind) { uploadKind.value = kind; fileInput.value?.click() }
const missing = (id: string | null, list: Asset[]) => id !== null && props.assetsStatus === 'ready' && !list.some(a => a.id === id)

// Refresh on open: another window may have changed the library.
onMounted(() => { void props.loadAssets(); void loadModels() })
watch(() => draft.value.id, () => { problem.value = '' })
function select(character: Character) {
  if (dirty.value && !confirm('目前角色有尚未保存的變更，確定要放棄嗎？')) return
  selectedId.value = character.id; draft.value = clone(character)
}
function create() {
  if (dirty.value && !confirm('目前角色有尚未保存的變更，確定要放棄嗎？')) return
  draft.value = props.newCharacter(); selectedId.value = draft.value.id
}
function save() {
  if (draft.value.presentation.modelId && !models.value.some(m => m.id === draft.value.presentation.modelId)) { problem.value = '模型索引已不存在，請重新選擇或清除綁定。'; return }
  problem.value = props.saveCharacter(draft.value)
}
function revert() { draft.value = stored.value ? clone(stored.value) : props.newCharacter(); problem.value = '' }
function remove() {
  if (isNew.value) { const first = props.characters[0]!; selectedId.value = first.id; draft.value = clone(first); return }
  if (!confirm(`確定要刪除「${stored.value!.name}」嗎？此操作無法復原。`)) return
  problem.value = props.deleteCharacter(draft.value.id)
  if (!problem.value) { const first = props.characters[0]!; selectedId.value = first.id; draft.value = clone(first) }
}
function close() { if (!dirty.value || confirm('有尚未保存的角色變更，確定要關閉嗎？')) emit('close') }
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, files = [...input.files ?? []]
  uploading.value = true
  for (const file of files) await props.uploadAsset(file, uploadKind.value)
  uploading.value = false; input.value = ''
}
async function removeAsset(asset: Asset) { if (confirm(`確定要刪除素材「${asset.name}」嗎？`)) await props.deleteAsset(asset.id) }
defineExpose({ close })
</script>

<template>
  <section class="modal manager" role="dialog" aria-modal="true" aria-label="角色與素材" @keydown.esc.stop="close">
    <header><h2>角色與素材</h2><button class="icon-button" aria-label="關閉視窗" @click="close">×</button></header>
    <div class="manager-tabs" role="tablist" aria-label="管理內容">
      <button role="tab" :aria-selected="tab === 'characters'" :class="{ active: tab === 'characters' }" @click="tab = 'characters'">角色 <span>{{ characters.length }}</span></button>
      <button role="tab" :aria-selected="tab === 'assets'" :class="{ active: tab === 'assets' }" @click="tab = 'assets'">素材庫 <span>{{ assets.length }}</span></button>
      <button role="tab" :aria-selected="tab === 'memories'" :class="{ active: tab === 'memories' }" @click="tab = 'memories'">記憶 <span>{{ memoryCharacter.memories.length }}</span></button>
    </div>
    <div v-if="tab === 'characters'" class="manager-body">
      <nav class="character-roster" aria-label="角色清單">
        <button v-for="c in characters" :key="c.id" :class="{ active: c.id === draft.id }" @click="select(c)">
          <img v-if="c.portraitAssetId" :src="assetUrl(c.portraitAssetId)" alt="" /><span v-else class="roster-mark">{{ [...c.name][0] }}</span>
          <span><strong>{{ c.name }}</strong><small>{{ usage[c.id] ?? 0 }} 段對話</small></span>
        </button>
        <button v-if="isNew" class="active"><span class="roster-mark">＋</span><span><strong>{{ draft.name || '新角色' }}</strong><small>尚未保存</small></span></button>
        <button class="roster-add" @click="create">＋ 新增角色</button>
      </nav>
      <form class="character-form" @submit.prevent="save">
        <div class="form-grid">
          <label>名稱<input v-model="draft.name" :maxlength="CHARACTER_LIMITS.name" required /></label>
          <label>副標／英文名<input v-model="draft.subtitle" :maxlength="CHARACTER_LIMITS.subtitle" placeholder="MIO" /></label>
          <label>身分標籤<input v-model="draft.tag" :maxlength="CHARACTER_LIMITS.tag" placeholder="書店的守候者" /></label>
          <label>場景名稱<input v-model="draft.scene" :maxlength="CHARACTER_LIMITS.scene" placeholder="雨後書店" /></label>
          <label>立繪<select v-model="draft.portraitAssetId"><option :value="null">內建插畫</option><option v-for="a in portraits" :key="a.id" :value="a.id">{{ a.name }}</option><option v-if="missing(draft.portraitAssetId, portraits)" :value="draft.portraitAssetId">（素材已遺失）</option></select></label>
          <label>背景<select v-model="draft.backgroundAssetId"><option :value="null">內建書店</option><option v-for="a in backgrounds" :key="a.id" :value="a.id">{{ a.name }}</option><option v-if="missing(draft.backgroundAssetId, backgrounds)" :value="draft.backgroundAssetId">（素材已遺失）</option></select></label>
        </div>
        <fieldset class="form-section"><legend>表情立繪 <small>未設定的表情使用上面的「立繪」。模型在每則回覆開頭標表情。</small></legend>
          <div class="expression-grid">
            <label v-for="e in EXPRESSIONS" :key="e.key">{{ e.label }}<select :value="draft.expressions[e.key] ?? null" @change="setExpression(e.key, ($event.target as HTMLSelectElement).value || null)"><option value="">預設立繪</option><option v-for="a in portraits" :key="a.id" :value="a.id">{{ a.name }}</option><option v-if="missing(draft.expressions[e.key] ?? null, portraits)" :value="draft.expressions[e.key]">（素材已遺失）</option></select></label>
          </div>
        </fieldset>
        <fieldset class="form-section"><legend>角色呈現</legend>
          <div class="form-grid">
            <label>呈現模式<select v-model="draft.presentation.mode" aria-label="角色呈現模式"><option value="portrait">靜態立繪</option><option value="live2d">Live2D</option></select></label>
            <label>Live2D 模型<select v-model="draft.presentation.modelId" aria-label="角色 Live2D 模型"><option :value="null">未綁定</option><option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}{{ m.available ? '' : '（缺檔）' }}</option><option v-if="draft.presentation.modelId && !previewModel" :value="draft.presentation.modelId">（模型索引已遺失）</option></select></label>
          </div>
          <div class="form-grid framing-grid">
            <label>預設取景<select :value="draft.presentation.framing ?? 'full'" aria-label="預設取景" @change="draft.presentation.framing = ($event.target as HTMLSelectElement).value as 'full' | 'bust'"><option value="full">全身</option><option value="bust">上半身</option></select><small>舞台右下角也可以隨時切換。內建插畫本身只有上半身。</small></label>
            <label>上半身縮放 {{ bustOf(draft.presentation).zoom.toFixed(1) }}×<input type="range" min="1.2" max="4" step="0.1" aria-label="上半身縮放" :value="bustOf(draft.presentation).zoom" @input="setBust('bustZoom', Number(($event.target as HTMLInputElement).value))" /></label>
            <label>上半身焦點 {{ Math.round(bustOf(draft.presentation).focus * 100) }}%<input type="range" min="0" max="1" step="0.05" aria-label="上半身焦點高度" :value="bustOf(draft.presentation).focus" @input="setBust('bustFocus', Number(($event.target as HTMLInputElement).value))" /><small>越高越靠近頭部。預設 {{ BUST_DEFAULTS.focus * 100 }}%。</small></label>
          </div>
          <template v-if="draft.presentation.mode === 'live2d'">
            <p class="muted">載入中或失敗時使用原立繪。語音嘴型將於後續批次接入。</p>
            <div class="form-grid">
              <label>角色縮放 {{ draft.presentation.scale.toFixed(2) }}<input v-model.number="draft.presentation.scale" aria-label="Live2D 角色縮放" type="range" min="0.5" max="3" step="0.05" /></label>
              <label>水平位置 {{ draft.presentation.x.toFixed(2) }}<input v-model.number="draft.presentation.x" aria-label="Live2D 水平位置" type="range" min="-1" max="1" step="0.05" /></label>
              <label>垂直位置 {{ draft.presentation.y.toFixed(2) }}<input v-model.number="draft.presentation.y" aria-label="Live2D 垂直位置" type="range" min="-1" max="1" step="0.05" /></label>
              <label class="toggle"><input v-model="draft.presentation.gaze" type="checkbox" /> 視線跟隨舞台游標</label>
            </div>
            <div class="live2d-mapping">
              <p v-if="capsProblem" class="form-problem" role="alert">{{ capsProblem }}</p>
              <p v-else-if="!modelCaps" class="muted">{{ previewModel ? '正在讀取模型的表情與動作…' : '選擇模型後可設定表情與動作。' }}</p>
              <template v-else>
                <div class="mapping-head"><strong>表情對應</strong><small>AI 標的表情 → 模型表情。未設定時用「平靜」的對應，再沒有就不套表情。</small><button type="button" class="link-button" @click="suggestMapping">依名稱自動對應</button></div>
                <p v-if="!modelCaps.expressions.length" class="muted">此模型沒有 exp3 表情檔。</p>
                <div v-else class="mapping-grid">
                  <label v-for="e in EXPRESSIONS" :key="e.key">{{ e.label }}<span><select :value="draft.presentation.expressionMap?.[e.key] ?? ''" :aria-label="`${e.label}對應的模型表情`" @change="setMapped('expressionMap', e.key, ($event.target as HTMLSelectElement).value)"><option value="">未設定</option><option v-for="name in modelCaps.expressions" :key="name" :value="name">{{ name }}</option></select><button type="button" :disabled="!previewLive" :title="previewLive ? '在預覽中套用' : '先開啟預覽'" @click="tryExpression(e.key)">試看</button></span></label>
                </div>
                <div class="mapping-head"><strong>動作對應</strong><small>只會播放這裡指定的動作；待機會循環，其他在狀態切換時播一次。</small></div>
                <p v-if="!motionOptions.length" class="muted">此模型沒有 motion3 動作檔。</p>
                <div v-else class="mapping-grid">
                  <label v-for="c in STAGE_CUES" :key="c.key">{{ c.label }}<span><select :value="draft.presentation.motionMap?.[c.key] ?? ''" :aria-label="`${c.label}的動作`" @change="setMapped('motionMap', c.key, ($event.target as HTMLSelectElement).value)"><option value="">不播放</option><option v-for="o in motionOptions" :key="o.value" :value="o.value">{{ o.label }}</option></select><button type="button" :disabled="!previewLive || c.key === 'idle'" @click="tryCue(c.key)">試播</button></span></label>
                </div>
              </template>
            </div>
            <div class="live2d-actions"><button type="button" :disabled="!previewModel" @click="previewLive = !previewLive; previewError = ''">{{ previewLive ? '停止預覽' : '預覽模型' }}</button><button type="button" @click="Object.assign(draft.presentation, { scale: defaultPresentation().scale, x: defaultPresentation().x, y: defaultPresentation().y })">重設位置與縮放</button></div>
            <div v-if="previewLive && previewModel && !previewError" class="live2d-preview character-live-preview"><Live2DStage :key="previewModel.id" :model-url="previewModel.entry" :view="draft.presentation" :act="previewAct" @failed="previewError = $event" /></div>
            <p v-if="previewError" class="form-problem" role="alert">{{ previewError }}</p>
          </template>
          <details class="model-library"><summary>本機模型索引（{{ models.length }}）</summary>
            <p class="muted">索引指向已放入 public/live2d/local/models 的模型包。移除索引可重新登錄，模型檔案會保留。</p>
            <p class="muted">要新增模型，請到「素材庫」頁籤匯入 ZIP 模型包。<button type="button" class="link-button" @click="tab = 'assets'">前往素材庫 ↗</button></p>
            <button type="button" :disabled="modelsLoading || modelBusy" @click="loadModels">重新檢查</button>
            <p v-if="modelProblem" class="form-problem" role="alert">{{ modelProblem }}</p>
            <ul><li v-for="m in models" :key="m.id"><strong>{{ m.name }}</strong><small>{{ m.available ? '可用' : m.problem }} · {{ modelUsers(m.id).join('、') || '未被角色引用' }}</small><code>{{ m.entry }}</code><button type="button" :disabled="!!modelUsers(m.id).length || modelBusy" @click="forgetModel(m.id)">移除索引</button></li></ul>
            <div class="form-grid"><label>模型名稱<input v-model="modelName" maxlength="100" /></label><label>模型入口<input v-model="modelEntry" aria-label="新增模型入口" maxlength="1000" placeholder="/live2d/local/models/名稱/名稱.model3.json" /></label></div>
            <button type="button" :disabled="modelBusy || !modelName.trim()" @click="registerLocalModel">加入本機模型索引</button>
          </details>
        </fieldset>
        <fieldset class="form-section"><legend>語音</legend>
          <div class="form-grid">
            <label>瀏覽器語音<select v-model="draft.voice.browserVoice" :disabled="!voiceSupported"><option value="">自動選擇中文語音</option><option v-for="v in voices" :key="v.uri" :value="v.uri">{{ v.name }} · {{ v.lang }}</option></select></label>
            <label>本機 TTS 聲音
              <select v-if="ttsVoices.length" v-model="draft.voice.httpVoice" aria-label="本機 TTS 聲音" @change="sampleTtsVoice"><option value="">服務預設{{ ttsDefault ? `（${ttsVoices.find(v => v.id === ttsDefault)?.label ?? ttsDefault}）` : '' }}</option><option v-for="v in ttsVoices" :key="v.id" :value="v.id">{{ v.label }}（{{ v.id }}）</option><option v-if="draft.voice.httpVoice && !ttsVoices.some(v => v.id === draft.voice.httpVoice)" :value="draft.voice.httpVoice">{{ draft.voice.httpVoice }}（清單中沒有）</option></select>
              <input v-else v-model="draft.voice.httpVoice" maxlength="200" :disabled="!ttsAvailable" :placeholder="ttsAvailable ? '傳給 TTS 服務的 voice 參數' : '未設定 TTS_URL'" />
              <small v-if="ttsVoicesProblem" class="muted">{{ ttsVoicesProblem }}</small></label>
            <label>語速 {{ draft.voice.rate.toFixed(1) }}<input v-model.number="draft.voice.rate" type="range" min="0.5" max="2" step="0.1" /></label>
            <label>音高 {{ draft.voice.pitch.toFixed(1) }}<input v-model.number="draft.voice.pitch" type="range" min="0.5" max="2" step="0.1" /></label>
          </div>
          <button type="button" class="link-button" @click="preview">♪ 用開場台詞試聽</button>
          <p v-if="voiceUnsaved" class="voice-unsaved" role="status">語音設定尚未保存。試聽已使用新設定，按下方「保存變更」後，對話朗讀才會改用。</p>
        </fieldset>
        <label>開場台詞<textarea v-model="draft.greeting" rows="3" :maxlength="CHARACTER_LIMITS.greeting" required></textarea><small>只套用在之後新開的對話。</small></label>
        <label>角色設定提示（system prompt）<textarea v-model="draft.systemPrompt" rows="6" :maxlength="CHARACTER_LIMITS.systemPrompt" required></textarea><small>{{ draft.systemPrompt.length }} / {{ CHARACTER_LIMITS.systemPrompt }} 字 · 下一次生成起套用到此角色的所有對話。</small></label>
        <p v-if="problem" class="form-problem" role="alert">{{ problem }}</p>
        <div class="form-actions">
          <button type="submit" class="primary" :disabled="!dirty">{{ isNew ? '新增角色' : '保存變更' }}</button>
          <button type="button" :disabled="!dirty" @click="revert">還原</button>
          <button type="button" :disabled="dirty" :title="dirty ? '請先保存角色' : ''" @click="emit('start', draft.id)">與此角色開始新對話 ↗</button>
          <button type="button" class="danger" @click="remove">{{ isNew ? '捨棄' : '刪除角色' }}</button>
        </div>
      </form>
    </div>
    <div v-else-if="tab === 'memories'" class="manager-body memories-body">
      <div class="memory-toolbar">
        <label>角色<select v-model="memoryCharacterId"><option v-for="c in characters" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
        <label class="toggle"><input type="checkbox" :checked="memoryCharacter.memoryEnabled" @change="setMemoryEnabled(memoryCharacter.id, ($event.target as HTMLInputElement).checked)" /> 使用長期記憶並自動整理</label>
        <button :disabled="memoryStatus === 'working'" @click="summarizeNow(activeConversationId)">{{ memoryStatus === 'working' ? '整理中…' : '整理目前對話 ↻' }}</button>
      </div>
      <p class="muted">每累積幾輪對話，模型會自動把值得記住的事寫進這裡；生成回覆時會帶入記憶。手動新增或修改過的記憶不會被自動清除。</p>
      <p v-if="memoryStatus === 'error'" class="form-problem" role="alert">{{ memoryError }}</p>
      <form class="memory-add" @submit.prevent="add"><input v-model="newMemory" :maxlength="MEMORY_LIMITS.text" placeholder="手動新增一則記憶，例如：使用者喜歡雨天" aria-label="新增記憶" /><button class="primary" :disabled="!newMemory.trim()">新增</button></form>
      <p v-if="memoryProblem" class="form-problem" role="alert">{{ memoryProblem }}</p>
      <div v-if="!memories.length" class="empty-state"><span>✎</span><h3>{{ memoryCharacter.name }}還沒有記憶</h3><p>多聊幾句，或手動寫下想讓角色記住的事。</p></div>
      <ul class="memory-list">
        <li v-for="m in memories" :key="m.id">
          <template v-if="editing?.id === m.id"><textarea v-model="editing.text" rows="2" :maxlength="MEMORY_LIMITS.text" aria-label="編輯記憶"></textarea><div><button class="primary" @click="commitEdit">保存</button><button @click="editing = null">取消</button></div></template>
          <template v-else><p>{{ m.text }}</p><div><small>{{ m.source === 'auto' ? '自動整理' : '手動' }} · {{ when(m.createdAt) }}</small><button @click="editing = { id: m.id, text: m.text }">編輯</button><button class="danger" @click="forget(m.id)">刪除</button></div></template>
        </li>
      </ul>
    </div>
    <div v-else class="manager-body assets-body">
      <div class="asset-toolbar">
        <div class="asset-filters" role="tablist" aria-label="素材分類">
          <button v-for="f in filters" :key="f.key" role="tab" :aria-selected="assetFilter === f.key" :class="{ active: assetFilter === f.key }" @click="assetFilter = f.key">{{ f.label }} <span>{{ f.count }}</span></button>
        </div>
        <input v-model="assetQuery" type="search" placeholder="搜尋素材名稱" aria-label="搜尋素材名稱" />
        <select v-model="assetSort" aria-label="排序"><option value="newest">最新上傳</option><option value="name">名稱</option><option value="size">檔案大小</option></select>
      </div>
      <input ref="fileInput" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple tabindex="-1" aria-hidden="true" @change="upload" />
      <p v-if="assetError" class="form-problem" role="alert">{{ assetError }}<button v-if="assetsStatus === 'error'" @click="loadAssets">重試</button></p>
      <p v-if="assetsStatus === 'loading' && !assets.length" class="muted">正在讀取素材…</p>
      <template v-else>
        <section v-for="group in assetGroups" :key="group.kind" class="asset-section" :aria-label="group.title">
          <header>
            <h3>{{ group.title }} <span>{{ group.total }}</span></h3>
            <small>{{ group.hint }}</small>
            <button class="upload-button" :class="{ busy: uploading }" :disabled="uploading" @click="pick(group.kind)">{{ uploading && uploadKind === group.kind ? '上傳中…' : `＋ 上傳${group.short}` }}</button>
          </header>
          <p v-if="!group.total" class="asset-empty">還沒有{{ group.short }}。{{ group.kind === 'portrait' ? '上傳後可在角色設定中選為立繪或表情。' : '上傳後可設為角色背景或對話場景。' }}</p>
          <p v-else-if="!group.buckets.length" class="asset-empty">沒有符合條件的{{ group.short }}。</p>
          <div v-for="bucket in group.buckets" :key="bucket.key" class="asset-bucket">
            <h4 v-if="group.buckets.length > 1 || bucket.key !== 'all'">{{ bucket.title }} <span>{{ bucket.items.length }}</span></h4>
            <div class="asset-grid" :class="group.kind">
              <article v-for="asset in bucket.items" :key="asset.id" class="asset-card">
                <img :src="assetUrl(asset.id)" :alt="asset.name" loading="lazy" />
                <strong :title="asset.name">{{ asset.name }}</strong>
                <small>{{ size(asset.size) }} · {{ date(asset.createdAt) }}</small>
                <ul v-if="uses(asset).length" class="asset-uses"><li v-for="use in uses(asset)" :key="use">{{ use }}</li></ul>
                <small v-else class="unused">未使用</small>
                <button :disabled="!!uses(asset).length" :title="uses(asset).length ? '請先更換使用此素材的角色或場景' : ''" @click="removeAsset(asset)">刪除</button>
              </article>
            </div>
          </div>
        </section>
      </template>
      <small class="asset-note">PNG／JPEG／WebP／GIF，單檔 8 MB 以內，可一次選多張。檔案保存在本機 data/assets。</small>
      <section v-if="assetFilter === 'all'" class="asset-section" aria-label="Live2D 模型">
        <header><h3>Live2D 模型 <span>{{ models.length }}</span></h3><small>已安裝的模型可在「角色 → 角色呈現」選用；檔案保存在 public/live2d/local/models。</small></header>
        <ul class="installed-models"><li v-for="m in models" :key="m.id"><strong>{{ m.name }}</strong><small :class="{ unused: !modelUsers(m.id).length }">{{ m.available ? '可用' : '缺檔' }} · {{ modelUsers(m.id).length ? `使用中：${modelUsers(m.id).join('、')}` : '未被角色使用' }}</small></li></ul>
        <Live2DImport :apply-target="draft.name" @installed="onImported" />
      </section>
    </div>
  </section>
</template>
