<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { messageStatus, tokenDescription } from '../chat/model'
import type { Message, Saved } from '../chat/model'

const props = defineProps<{
  tab: 'long' | 'saved'; message: Message; sourceTitle: string
  tokens: string; status: string; isSaved: boolean; canSave: boolean
  threshold: number; savedItems: Saved[]; savedCount: number
  query: string; scope: 'all' | 'current'; conversationTitles: Record<string, string>
  characterName: string; characterSubtitle: string; conversationCharacters: Record<string, string>
}>()
const emit = defineEmits<{
  close: []; tab: [value: 'long' | 'saved']; save: []; stage: []
  jump: [item: Saved]; remove: [id: string]; query: [value: string]; scope: [value: 'all' | 'current']
}>()
const scrollArea = ref<HTMLElement>()
const host = (url: string) => { try { return new URL(url).hostname } catch { return url } }
const following = ref(true), hasNewText = ref(false)
const partial = computed(() => ['stopped', 'error'].includes(props.message.status) || props.message.finishReason === 'length')
function onScroll() {
  const el = scrollArea.value
  if (!el) return
  following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 55
  if (following.value) hasNewText.value = false
}
function latest() { const el = scrollArea.value; if (el) el.scrollTop = el.scrollHeight; following.value = true; hasNewText.value = false }
watch(() => [props.message.id, props.tab, props.message.text], async ([id, tab], [oldId, oldTab]) => {
  if (id !== oldId || tab !== oldTab) {
    following.value = true; hasNewText.value = false
    await nextTick()
    if (scrollArea.value) scrollArea.value.scrollTop = 0
    return
  }
  const follow = following.value
  await nextTick()
  if (props.tab !== 'long') return
  if (follow) latest()
  else hasNewText.value = true
})
async function tabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const tab = event.key === 'Home' ? 'long' : event.key === 'End' ? 'saved' : props.tab === 'long' ? 'saved' : 'long'
  emit('tab', tab)
  await nextTick()
  document.getElementById(`${tab}-tab`)?.focus()
}
</script>

<template>
  <aside class="detail-sidebar" aria-label="長文與收藏">
    <header><h2>故事的書籤</h2><button class="icon-button" aria-label="關閉右欄" @click="emit('close')">×</button></header>
    <div class="detail-tabs" role="tablist" aria-label="右欄內容" @keydown="tabKey">
      <button id="long-tab" role="tab" :tabindex="tab === 'long' ? 0 : -1" :aria-selected="tab === 'long'" aria-controls="detail-content" :class="{ active: tab === 'long' }" @click="emit('tab', 'long')">台詞全文</button>
      <button id="saved-tab" role="tab" :tabindex="tab === 'saved' ? 0 : -1" :aria-selected="tab === 'saved'" aria-controls="detail-content" :class="{ active: tab === 'saved' }" @click="emit('tab', 'saved')">收藏 <span>{{ savedCount }}</span></button>
    </div>
    <div v-if="tab === 'saved'" class="favorite-filters">
      <input :value="query" aria-label="搜尋收藏" placeholder="搜尋台詞或對話名稱" @input="emit('query', ($event.target as HTMLInputElement).value)" />
      <div><button :aria-pressed="scope === 'all'" @click="emit('scope', 'all')">全部故事</button><button :aria-pressed="scope === 'current'" @click="emit('scope', 'current')">目前對話</button><span>{{ savedItems.length }} 則</span></div>
    </div>
    <div id="detail-content" ref="scrollArea" class="detail-scroll" role="tabpanel" :aria-labelledby="tab === 'long' ? 'long-tab' : 'saved-tab'" tabindex="0" @scroll="onScroll">
      <template v-if="tab === 'long'">
        <div class="detail-eyebrow">{{ characterSubtitle || characterName }} · 台詞全文</div>
        <h3>把這一刻，慢慢讀完。</h3>
        <button class="source-link" @click="emit('stage')">{{ sourceTitle }} · 回到這則台詞 ↗</button>
        <div class="reply-status" :class="{ partial, live: message.status === 'generating' }">{{ status }}</div>
        <div class="token-note">{{ tokens }}<span v-if="message.tokens > threshold">超過 {{ threshold }} tokens 門檻</span></div>
        <p v-if="partial" class="partial-note">這段內容尚未完整結束，收藏會保留這次收到的台詞。</p>
        <p class="full-text">{{ message.text || (message.status === 'generating' ? `${characterName}正在整理思緒…` : '這次尚未收到台詞。') }}</p>
        <p v-if="message.error" class="partial-note">{{ message.error }}</p>
        <div v-if="message.searches?.length" class="source-list">
          <h4>⌕ 上網查了 {{ message.searches.length }} 次</h4>
          <p>{{ message.searches.map(q => `「${q}」`).join('、') }}</p>
          <ol v-if="message.sources?.length"><li v-for="s in message.sources" :key="s.url"><a :href="s.url" target="_blank" rel="noopener noreferrer">{{ s.title }}</a><small>{{ host(s.url) }}</small></li></ol>
        </div>
        <p v-if="message.completionTokens !== undefined" class="usage-note">模型總生成：{{ message.completionTokens }} tokens</p>
        <button class="save-full" :disabled="!canSave" @click="emit('save')">{{ isSaved ? '★ 已加入收藏 · 點擊取消' : '☆ 收藏這段對話' }}</button>
      </template>
      <template v-else>
        <div v-if="!savedCount" class="empty-state"><span>♧</span><h3>留住喜歡的片刻</h3><p>點擊對話旁的「收藏」，<br />讓想重讀的話留在這裡。</p></div>
        <div v-else-if="!savedItems.length" class="empty-state"><span>⌕</span><h3>還沒找到這段回憶</h3><p>試試其他關鍵字，<br />或切換到「全部故事」。</p></div>
        <article v-for="item in savedItems" :key="item.id" class="saved-card">
          <span>{{ conversationCharacters[item.conversationId] }} · {{ conversationTitles[item.conversationId] }}</span>
          <div class="saved-status">{{ messageStatus(item.message) }} · {{ tokenDescription(item.message) }}</div>
          <p>{{ item.message.text }}</p>
          <div><button @click="emit('jump', item)">回到來源 ↗</button><button aria-label="移除此收藏" @click="emit('remove', item.id)">移除</button></div>
        </article>
      </template>
    </div>
    <button v-if="tab === 'long' && hasNewText" class="latest-text" @click="latest">有新台詞 · 回到最新內容 ↓</button>
    <footer>每一頁，都是我們的共同記憶。</footer>
  </aside>
</template>
