<script setup lang="ts">
import CharacterStage from './components/CharacterStage.vue'
import Live2DPreview from './components/Live2DPreview.vue'
import DetailSidebar from './components/DetailSidebar.vue'
import CharacterManager from './components/CharacterManager.vue'
import ScenePicker from './components/ScenePicker.vue'
import { useModelCatalog } from './live2d/catalog'
import { cueFor } from './live2d/director'
import { assetUrl, expressionLabel, portraitFor } from '../shared/characters'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useChat } from './composables/useChat'
const { voiceStream, voiceSync, voicePhase, lipSource, mouthLevel, setFraming, searchAvailable, searchingHint, showFull, voiceEnabled, voiceAuto, voiceEngine, ttsAvailable, voices, voiceSupported, voiceError, speakingCurrent, toggleVoice, previewVoice, stageExpression, setScene, addMemory, updateMemory, deleteMemory, setMemoryEnabled, summarizeNow, memoryStatus, memoryError, characters, activeCharacter, characterOf, charactersOpen, saveCharacter, deleteCharacter, newCharacter, assets, assetsStatus, assetError, loadAssets, uploadAsset, deleteAsset, storageReady, storageStatus, storageError, storageLabel, restoreStorage, flushStorage, conversations, activeId, active, displayMessage, detailMessage, page, input, search, panel, leftOpen, historyOpen, settingsOpen, threshold, speed, maxTokens, saved, visibleSaved, favoriteQuery, favoriteScope, notice, visibleText, playing, filtered, isSaved, canSave, canRetry, detailIsSaved, detailCanSave, detailTokens, detailStatus, unreadLongCount, connection, connectionError, modelName, endpoint, context, generating, currentGenerating, statusLabel, readingHint, next, choose, showOnStage, toggleFull, readUnread, addConversation, deleteConversation, generation, respond, retry, stop, toggleSave, removeSaved, jump, checkConnection } = useChat()
const conversationTitles = computed(() => Object.fromEntries(conversations.value.map(c => [c.id, c.title])))
const catalog = useModelCatalog()
onMounted(() => { void catalog.load() })
const liveModelUrl = computed(() => catalog.models.value.find(m => m.id === activeCharacter.value.presentation.modelId)?.entry ?? null)
const conversationCharacters = computed(() => Object.fromEntries(conversations.value.map(c => [c.id, characterOf(c).name])))
const characterUsage = computed(() => conversations.value.reduce<Record<string, number>>((count, c) => { count[c.characterId] = (count[c.characterId] ?? 0) + 1; return count }, {}))
const portraitUrl = computed(() => { const id = portraitFor(activeCharacter.value, stageExpression.value); return id ? assetUrl(id) : null })
const backgroundUrl = computed(() => { const id = active.value.backgroundAssetId ?? activeCharacter.value.backgroundAssetId; return id ? assetUrl(id) : null })
const sceneUsage = computed(() => conversations.value.reduce<Record<string, string[]>>((used, c) => { if (c.backgroundAssetId) (used[c.backgroundAssetId] ??= []).push(c.title); return used }, {}))
// Only the active conversation's reply drives the stage; background generations never do.
const stageCue = computed(() => cueFor(displayMessage.value))
// The built-in illustration is already upper-body only, so framing applies to Live2D and uploaded portraits.
const canFrame = computed(() => (activeCharacter.value.presentation.mode === 'live2d' && !!liveModelUrl.value) || !!portraitUrl.value)
const framing = computed(() => activeCharacter.value.presentation.framing ?? 'full')
const sceneName = computed(() => active.value.sceneLabel || activeCharacter.value.scene)
const live2dOpen = ref(false)
const sceneOpen = ref(false), managerTab = ref<'characters' | 'assets' | 'memories'>('characters')
function openManager(tab: 'characters' | 'assets' | 'memories' = 'characters') { managerTab.value = tab; sceneOpen.value = false; charactersOpen.value = true }
const manager = ref<InstanceType<typeof CharacterManager>>()
// The dialogue box follows the typing cursor line by line, unless the reader has scrolled back up.
const dialogueBox = ref<HTMLElement>(), typingCursor = ref<HTMLElement>()
let followTyping = true
function cursorBelow() {
  const box = dialogueBox.value, cursor = typingCursor.value
  if (!box || !cursor) return 0
  return cursor.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom + parseFloat(getComputedStyle(box).paddingBottom || '0')
}
function onDialogueScroll() {
  const box = dialogueBox.value
  if (!box) return
  // Reading earlier lines pauses following; returning to the cursor (or the bottom) resumes it.
  followTyping = cursorBelow() <= 4 || box.scrollHeight - box.scrollTop - box.clientHeight < 8
}
watch(visibleText, async () => {
  await nextTick()
  const box = dialogueBox.value, below = cursorBelow()
  if (box && followTyping && below > 0) box.scrollTop += below
})
watch(() => [displayMessage.value.id, page.value, activeId.value], async () => {
  followTyping = true
  await nextTick()
  if (dialogueBox.value) dialogueBox.value.scrollTop = 0
})
function removeConversation(id: string, title: string) {
  if (!confirm(`確定要刪除對話「${title}」嗎？對話內容與相關收藏都會一併移除，此操作無法復原。`)) return
  const problem = deleteConversation(id)
  if (problem) alert(problem)
}
</script>

<template>
  <div v-if="!storageReady" class="storage-screen" role="status">
    <div><span class="brand-mark">✦</span><h2>{{ storageStatus === 'loading' ? '正在找回我們的故事…' : '暫時無法載入故事' }}</h2>
    <p>{{ storageError || '正在讀取本機保存的對話與收藏。' }}</p><button v-if="storageError" @click="restoreStorage">重試載入</button></div>
  </div>
  <div v-if="storageReady && storageError" class="storage-alert" role="alert"><span>{{ storageError }}<small v-if="storageStatus === 'conflict'">重新載入會捨棄此視窗尚未保存的變更。</small></span><button v-if="storageStatus === 'conflict'" @click="restoreStorage">重新載入已保存版本</button><button v-else @click="flushStorage">重試保存</button></div>
  <div class="app-shell" :class="{ 'with-details': panel }" :inert="!storageReady">
    <button v-if="leftOpen" class="scrim" aria-label="關閉對話清單" @click="leftOpen = false"></button>
    <aside class="sidebar" :class="{ 'mobile-open': leftOpen }">
      <a class="brand" href="#" @click.prevent="choose(conversations[0]!.id)"><span class="brand-mark">✦</span><span>栞 Shiori<small>每一次相遇，都值得留存</small></span></a>
      <button class="new-chat" @click="addConversation()"><span>＋</span> 開始新的對話</button><button class="manage-characters" @click="openManager()">☺ 角色與素材 <span>{{ characters.length }} 位</span></button>
      <label class="search"><span>⌕</span><input v-model="search" placeholder="搜尋對話" aria-label="搜尋對話" /></label>
      <div class="section-label">我們的故事 <span>{{ conversations.length }}</span></div>
      <nav class="conversation-list" aria-label="對話清單">
        <div v-for="conversation in filtered" :key="conversation.id" class="conversation-row"><button class="conversation" :class="{ active: activeId === conversation.id }" @click="choose(conversation.id)"><span class="conversation-icon">☷</span><span><strong>{{ conversation.title }}</strong><small>{{ characterOf(conversation).name }} · {{ conversation.time }}</small></span><span v-if="activeId === conversation.id" class="active-dot"></span><span v-if="conversation.view.unread.length" class="unread-dot" :aria-label="`${conversation.view.unread.length} 則長文待讀`">{{ conversation.view.unread.length }}</span></button><button class="conversation-delete" :disabled="conversations.length <= 1 || generation?.conversationId === conversation.id" :title="conversations.length <= 1 ? '至少需要保留一段對話' : generation?.conversationId === conversation.id ? '正在生成中，無法刪除' : '刪除對話'" :aria-label="`刪除對話「${conversation.title}」`" @click="removeConversation(conversation.id, conversation.title)">×</button></div>
        <p v-if="!filtered.length" class="empty-search">沒有符合的對話</p>
      </nav>
      <div class="sidebar-bottom"><div class="prototype-note"><span class="status-dot"></span> 本機 AI 對話 <span class="version">P4 · 角色</span></div><button class="settings-button" @click="settingsOpen = true">⚙ <span>偏好設定</span><span>›</span></button><div class="profile"><span class="profile-avatar">K</span><span>我的小天地<small>本機工作空間</small></span><button class="storage-state" :class="{ failed: storageError }" :aria-label="`保存狀態：${storageLabel}`" title="保存對話與閱讀進度" @click="flushStorage">{{ storageLabel }}</button></div></div>
    </aside>
    <main class="main-view">
      <header class="topbar"><div class="title-group"><button class="mobile-menu icon-button" aria-label="開啟對話清單" @click="leftOpen = true">☰</button><span class="breadcrumb">我們的故事</span><span class="slash">/</span><h1>{{ active.title }}</h1></div><div class="top-actions"><button class="live2d-open" aria-label="開啟 Live2D 本機試演" @click="live2dOpen = true">✧ Live2D</button><button class="demo-badge" :class="{ offline: connection === 'offline' }" :title="connectionError || modelName" @click="checkConnection"><span></span> {{ statusLabel }}</button><button class="icon-button" :class="{ selected: panel === 'saved' }" aria-label="開啟收藏" @click="panel = panel === 'saved' ? null : 'saved'">☆</button><button class="icon-button" aria-label="開啟偏好設定" @click="settingsOpen = true">⚙</button></div></header>
      <section class="stage-layout">
        <div class="stage"><CharacterStage :mouth="mouthLevel" :conversation-id="activeId" :message-id="displayMessage.id" :cue="stageCue" :character-id="activeCharacter.id" :presentation="activeCharacter.presentation" :model-url="liveModelUrl" :name="activeCharacter.name" :scene="sceneName" :expression="stageExpression" :portrait-url="portraitUrl" :background-url="backgroundUrl" /><button class="scene-caption" :aria-label="`切換場景，目前：${sceneName || '未命名'}`" @click="sceneOpen = true"><span class="scene-dot"></span> {{ sceneName || '切換場景' }} <span v-if="activeCharacter.id === 'mio' && !backgroundUrl && !active.sceneLabel">17:42 · 微雨初歇</span><span class="scene-edit">⛰</span></button><button v-if="canFrame" class="framing-toggle" :aria-pressed="framing === 'bust'" :aria-label="framing === 'bust' ? '切換為全身' : '切換為上半身'" @click="setFraming(activeCharacter.id, framing === 'bust' ? 'full' : 'bust')"><span :class="{ on: framing === 'full' }">全身</span><span :class="{ on: framing === 'bust' }">上半身</span></button><div class="chapter-label">CHAPTER 01 <span>不期而遇</span></div><div class="stage-bottom"><span>有些故事，從一句「你來了」開始。</span><span>✧</span></div></div>
        <section class="dialogue-area" aria-label="角色對話">
          <div class="dialogue-meta"><div class="character-label"><span class="avatar-mini">{{ [...activeCharacter.name][0] }}</span><strong>{{ activeCharacter.name }} <small v-if="activeCharacter.subtitle">{{ activeCharacter.subtitle }}</small></strong><span v-if="activeCharacter.tag" class="character-tag">{{ activeCharacter.tag }}</span><span v-if="speakingCurrent && voicePhase === 'playing'" class="lip-tag" :title="lipSource === 'audio' ? '嘴型依實際播放的音量變化' : '瀏覽器語音無法取得音訊，嘴型為近似節奏，不是精確同步'">{{ lipSource === 'audio' ? '♪ 音訊嘴型' : '♪ 簡化嘴型' }}</span><span class="expression-tag" :title="`目前表情：${expressionLabel(stageExpression)}`">{{ expressionLabel(stageExpression) }}</span></div><div class="dialogue-tools"><button v-if="voiceEnabled" :disabled="!displayMessage.text.trim()" :class="{ saved: speakingCurrent }" :aria-label="!speakingCurrent ? '朗讀目前回覆' : voicePhase === 'requesting' ? '取消語音準備' : '停止朗讀'" :title="voiceError" @click="toggleVoice">{{ !speakingCurrent ? '♪' : voicePhase === 'requesting' ? '…' : '■' }} <span>{{ !speakingCurrent ? '朗讀' : voicePhase === 'requesting' ? '準備中' : '停止' }}</span></button><button @click="historyOpen = true">☷ <span>歷史</span></button><button :disabled="!canSave" :class="{ saved: isSaved }" :aria-label="isSaved ? '取消收藏目前回覆' : '收藏目前回覆'" @click="toggleSave()">{{ isSaved ? '★' : '☆' }} <span>收藏</span></button><button aria-label="在右欄閱讀完整回覆" @click="toggleFull">☷ <span>全文</span></button></div></div>
          <div ref="dialogueBox" class="dialogue-text" @click="next" @scroll.passive="onDialogueScroll"><p>{{ visibleText || (displayMessage.status === 'generating' ? searchingHint || `${activeCharacter.name}正在整理思緒…` : displayMessage.status === 'error' ? '暫時沒有收到台詞。' : displayMessage.status === 'stopped' ? '這次回應已停止。' : '') }}<span v-if="playing" ref="typingCursor" class="typing-cursor">▏</span></p></div>
          <div class="reading-controls"><span>{{ readingHint }}</span><button v-if="playing" class="reveal-all" aria-label="立即顯示全部台詞" @click="next">顯示全部 ⏭</button></div>
          <button v-if="displayMessage.searches?.length" class="search-note" @click="showFull()">⌕ 查了「{{ displayMessage.searches.join('」、「') }}」<span v-if="displayMessage.sources?.length"> · {{ displayMessage.sources.length }} 個來源</span> ↗</button><div v-if="displayMessage.error" class="generation-notice" role="status"><span>{{ displayMessage.error }}</span><button v-if="canRetry" @click="retry">重新生成 ↻</button></div><div v-else-if="displayMessage.finishReason === 'length'" class="generation-notice">已達生成上限，可在設定調高後繼續對話。</div><form class="composer" @submit.prevent="respond()"><input v-model="input" :maxlength="12000" aria-label="對角色說的話" :placeholder="`想對${activeCharacter.name}說些什麼呢？`" autocomplete="off" /><span class="enter-hint">Enter ↵</span><button v-if="!generating" type="submit" :disabled="!input.trim()" aria-label="送出訊息">↑</button><button v-else type="button" class="stop-button" aria-label="停止生成" @click="stop">■</button></form>
          <div class="dialogue-footer"><button v-if="unreadLongCount" class="unread-button" @click="readUnread">{{ unreadLongCount }} 則長文待讀 ↗</button><span v-else>✧ 讓故事，照著你的步調前進。</span><span>{{ generating ? currentGenerating ? '正在生成 · 可停止' : '其他對話生成中' : 'llama.cpp · 本機推論' }}</span></div>
        </section>
      </section>
    </main>
    <DetailSidebar v-if="panel" :tab="panel" :message="detailMessage" :source-title="active.title" :character-name="activeCharacter.name" :character-subtitle="activeCharacter.subtitle" :conversation-characters="conversationCharacters"
      :tokens="detailTokens" :status="detailStatus" :is-saved="detailIsSaved" :can-save="detailCanSave" :threshold="threshold"
      :saved-items="visibleSaved" :saved-count="saved.length" :query="favoriteQuery" :scope="favoriteScope" :conversation-titles="conversationTitles"
      @close="panel = null" @tab="panel = $event" @save="toggleSave(detailMessage)" @stage="showOnStage(detailMessage.id); panel = null"
      @jump="jump" @remove="removeSaved" @query="favoriteQuery = $event" @scope="favoriteScope = $event" />
    <div v-if="live2dOpen" class="modal-backdrop" @click.self="live2dOpen = false"><Live2DPreview @close="live2dOpen = false" /></div>
    <div v-if="charactersOpen" class="modal-backdrop" @click.self="manager?.close()"><CharacterManager ref="manager" :initial-tab="managerTab" :scene-usage="sceneUsage" :active-conversation-id="activeId" :voices="voices" :voice-supported="voiceSupported" :tts-available="ttsAvailable" :preview-voice="previewVoice" :voice-engine="voiceEngine"
      :add-memory="addMemory" :update-memory="updateMemory" :delete-memory="deleteMemory" :set-memory-enabled="setMemoryEnabled" :summarize-now="summarizeNow" :memory-status="memoryStatus" :memory-error="memoryError" :characters="characters" :assets="assets" :assets-status="assetsStatus" :asset-error="assetError" :usage="characterUsage" :active-character-id="activeCharacter.id"
      :save-character="saveCharacter" :delete-character="deleteCharacter" :new-character="newCharacter" :upload-asset="uploadAsset" :delete-asset="deleteAsset" :load-assets="loadAssets" @close="charactersOpen = false" @start="addConversation" /></div>
    <div v-if="sceneOpen" class="modal-backdrop" @click.self="sceneOpen = false"><ScenePicker :assets="assets" :assets-status="assetsStatus" :background-asset-id="active.backgroundAssetId" :scene-label="active.sceneLabel" :character-scene="activeCharacter.scene" :character-background-id="activeCharacter.backgroundAssetId" :load-assets="loadAssets" :save="(bg, label) => setScene(active.id, bg, label)" @close="sceneOpen = false" @manage="openManager('assets')" /></div>
    <div v-if="notice" class="toast" role="status">✓ {{ notice }}</div>
    <div v-if="settingsOpen || historyOpen" class="modal-backdrop" @click.self="settingsOpen = false; historyOpen = false"><section class="modal" role="dialog" aria-modal="true" :aria-label="settingsOpen ? '偏好設定' : '對話歷史'"><header><h2>{{ settingsOpen ? '偏好設定' : '對話歷史' }}</h2><button class="icon-button" aria-label="關閉視窗" @click="settingsOpen = false; historyOpen = false">×</button></header><template v-if="settingsOpen"><p class="muted">對話、收藏、草稿、偏好與角色記憶會自動保存於本機 SQLite。<br />重新開啟時，會還原最近成功保存的閱讀進度。</p><label class="setting-row">長回覆展開門檻 <select v-model.number="threshold" aria-label="長回覆展開門檻"><option :value="150">150 tokens</option><option :value="300">300 tokens</option><option :value="500">500 tokens</option></select></label><label class="setting-row">台詞播放速度 <select v-model.number="speed" aria-label="台詞播放速度"><option :value="55">慢慢讀</option><option :value="32">標準</option><option :value="12">快速</option></select></label><label class="setting-row">生成上限 <select v-model.number="maxTokens" aria-label="生成上限"><option :value="256">256 tokens</option><option :value="512">512 tokens</option><option :value="1024">1024 tokens</option><option :value="2048">2048 tokens</option></select></label><label class="setting-row">語音朗讀 <input v-model="voiceEnabled" type="checkbox" aria-label="啟用語音朗讀" /></label><label class="setting-row">自動朗讀 <select :value="!voiceAuto ? 'off' : voiceStream ? 'stream' : 'after'" :disabled="!voiceEnabled" aria-label="自動朗讀" @change="(e) => { const v = (e.target as HTMLSelectElement).value; voiceAuto = v !== 'off'; if (v !== 'off') voiceStream = v === 'stream' }"><option value="off">關閉</option><option value="after">回覆完成後</option><option value="stream">邊生成邊朗讀</option></select></label><label class="setting-row">文字跟著語音顯示 <input v-model="voiceSync" type="checkbox" :disabled="!voiceEnabled" aria-label="文字跟著語音顯示" /></label><small v-if="voiceEnabled && voiceAuto && voiceStream && !(voiceEngine === 'http' && ttsAvailable)" class="muted">「邊生成邊朗讀」需要本機 TTS；目前會在回覆完成後才朗讀。</small><label class="setting-row">語音引擎 <select v-model="voiceEngine" :disabled="!voiceEnabled" aria-label="語音引擎"><option value="browser">瀏覽器內建{{ voiceSupported ? '' : '（不支援）' }}</option><option value="http" :disabled="!ttsAvailable">本機 TTS{{ ttsAvailable ? '' : '（未設定 TTS_URL）' }}</option></select></label><small class="muted">Live2D 嘴型：本機 TTS 會依實際播放的音量開合；瀏覽器內建語音取不到音訊，只提供「簡化嘴型」的近似節奏。</small><small v-if="voiceError" class="muted">{{ voiceError }}</small><div class="endpoint-info">AI 服務端點 <code>{{ endpoint }}</code><small>{{ modelName || '尚未取得模型資訊' }}</small><small>{{ connectionError || '回覆直接由本機模型生成；超長歷史會優先移除較舊回合。' }}</small><small>網路搜尋：{{ searchAvailable ? '已連接本機 MCP 搜尋服務，角色可以上網查資料' : '未連接（預設連 http://127.0.0.1:8081/mcp，可用 MCP_SEARCH_URL 設定）' }}</small><button class="reconnect" @click="checkConnection">重新檢查連線 ↻</button><small v-if="context">本次上下文：{{ context.source === 'estimate' ? '約 ' : '' }}{{ context.promptTokens }} / {{ context.contextLimit }} tokens；省略 {{ context.droppedMessages }} 則舊訊息。</small></div></template><template v-else><div class="history-list"><article v-for="message in active.messages" :key="message.id" :class="message.role"><strong>{{ message.role === 'assistant' ? activeCharacter.name : '你' }}</strong><p>{{ message.text || (message.status === 'generating' ? '生成中…' : '未收到台詞') }}</p><small v-if="message.error" class="muted">{{ message.error }}</small><button v-if="message.role === 'assistant'" @click="showOnStage(message.id)">在舞台閱讀 ↗</button></article></div></template></section></div>
  </div>
</template>






