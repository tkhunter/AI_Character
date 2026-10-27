<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { assetUrl } from '../../shared/characters'
import type { Asset } from '../../shared/characters'

const props = defineProps<{
  assets: Asset[]; assetsStatus: 'idle' | 'loading' | 'ready' | 'error'
  backgroundAssetId: string | null; sceneLabel: string; characterScene: string; characterBackgroundId: string | null
  loadAssets: () => Promise<void>; save: (backgroundAssetId: string | null, sceneLabel: string) => string
}>()
const emit = defineEmits<{ close: []; manage: [] }>()
const background = ref(props.backgroundAssetId), label = ref(props.sceneLabel), problem = ref('')
const backgrounds = computed(() => props.assets.filter(a => a.kind === 'background'))
// Refresh on open: another window may have changed the library.
onMounted(() => { void props.loadAssets() })
function apply() { problem.value = props.save(background.value, label.value); if (!problem.value) emit('close') }
</script>

<template>
  <section class="modal scene-picker" role="dialog" aria-modal="true" aria-label="切換場景" @keydown.esc.stop="emit('close')">
    <header><h2>切換場景</h2><button class="icon-button" aria-label="關閉視窗" @click="emit('close')">×</button></header>
    <p class="muted">只影響這段對話。換場景時舞台會淡入淡出。</p>
    <div class="scene-options" role="radiogroup" aria-label="場景背景">
      <button role="radio" aria-label="角色預設背景" :aria-checked="background === null" :class="{ active: background === null }" @click="background = null">
        <span class="scene-thumb inherit"><img v-if="characterBackgroundId" :src="assetUrl(characterBackgroundId)" alt="" /><span v-else>書店</span></span>
        <small>角色預設</small>
      </button>
      <button v-for="a in backgrounds" :key="a.id" role="radio" :aria-label="a.name" :aria-checked="background === a.id" :class="{ active: background === a.id }" @click="background = a.id">
        <span class="scene-thumb"><img :src="assetUrl(a.id)" alt="" loading="lazy" /></span><small :title="a.name">{{ a.name }}</small>
      </button>
    </div>
    <p v-if="assetsStatus === 'ready' && !backgrounds.length" class="muted">素材庫還沒有背景圖。<button class="link-button" @click="emit('manage')">前往素材庫上傳 ↗</button></p>
    <label class="scene-label">場景名稱<input v-model="label" maxlength="40" :placeholder="characterScene || '例如：放學後的教室'" /><small>留空時使用角色預設的場景名稱。</small></label>
    <p v-if="problem" class="form-problem" role="alert">{{ problem }}</p>
    <div class="form-actions"><button class="primary" @click="apply">套用場景</button><button @click="emit('close')">取消</button></div>
  </section>
</template>
