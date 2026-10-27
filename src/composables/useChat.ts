import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { createPersistence } from '../chat/persistence.ts'
import type { Workspace } from '../../shared/workspace.ts'
import { readSSE } from '../../shared/sse.ts'
import type { ChatEvent, ChatMessage, TokenSource } from '../../shared/protocol.ts'
import { characters as graphemes, createView, messageStatus, tokenDescription } from '../chat/model.ts'
import type { Conversation, Message, Saved } from '../chat/model.ts'
import { DEFAULT_EXPRESSION, MEMORY_LIMITS, characterAssets, characterProblem, defaultCharacter, expressionLabel } from '../../shared/characters.ts'
import type { Asset, AssetKind, Character } from '../../shared/characters.ts'
import { createVoice, type VoiceEngine } from '../chat/voice.ts'
import { createSentenceSplitter } from '../chat/sentences.ts'

/** Complete messages since the last summary before memories are distilled automatically. */
export const MEMORY_BATCH = 8

const newConversation = (id: string, character: Character, title: string): Conversation => ({ id, characterId: character.id, title, time: '剛剛', messages: [opening(character)], view: createView(), backgroundAssetId: null, sceneLabel: '', memoryCursor: 0 })
const opening = (character: Character): Message => ({ id: crypto.randomUUID(), role: 'assistant', text: character.greeting, tokens: 0, source: 'estimate', origin: 'opening', status: 'complete' })

/** Framework-independent lifetime, with an injectable transport for deterministic stream regressions. */
export function createChatState(fetcher: typeof fetch = fetch, options: { persistence?: boolean } = {}) {
  let hydrating = false
  const characters = ref<Character[]>([defaultCharacter()])
  const conversations = ref<Conversation[]>([newConversation('first', characters.value[0]!, '雨後的書店')])
  const activeId = ref('first')
  const active = computed(() => conversations.value.find(c => c.id === activeId.value)!)
  const characterOf = (conversation: Conversation) => characters.value.find(c => c.id === conversation.characterId) ?? characters.value[0]!
  const activeCharacter = computed(() => characterOf(active.value))
  const voice = createVoice(fetcher)
  const voiceEnabled = ref(true), voiceAuto = ref(false), voiceEngine = ref<VoiceEngine>('browser'), ttsAvailable = ref(false)
  // voiceStream: speak sentence by sentence while generating (local TTS); voiceSync: reveal text as it is spoken.
  const voiceStream = ref(true), voiceSync = ref(true)
  const memoryStatus = ref<'idle' | 'working' | 'error'>('idle'), memoryError = ref('')
  const assets = ref<Asset[]>([]), assetsStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle'), assetError = ref('')
  const view = computed(() => active.value.view)
  const assistantMessage = computed(() => [...active.value.messages].reverse().find(m => m.role === 'assistant')!)
  const selectedMessageId = computed({ get: () => view.value.selectedMessageId, set: value => { view.value.selectedMessageId = value; view.value.page = 0; view.value.visibleCount = 0 } })
  const displayMessage = computed(() => active.value.messages.find(m => m.id === selectedMessageId.value && m.role === 'assistant') ?? assistantMessage.value)
  const detailMessage = computed(() => active.value.messages.find(m => m.id === view.value.panelMessageId && m.role === 'assistant') ?? displayMessage.value)
  // The whole reply plays in one scrolling box; `page` stays 0 and is kept only for stored view state.
  const pages = computed(() => [displayMessage.value.text])
  const page = computed({ get: () => view.value.page, set: value => { view.value.page = Math.max(0, Math.min(value, pages.value.length - 1)); view.value.visibleCount = 0 } })
  const visibleCount = computed({ get: () => view.value.visibleCount, set: value => { view.value.visibleCount = value } })
  const input = computed({ get: () => view.value.draft, set: value => { view.value.draft = value } })
  const context = computed(() => view.value.context)
  const search = ref(''), favoriteQuery = ref('')
  const favoriteScope = ref<'all' | 'current'>('all')
  const generation = ref<{ conversationId: string; messageId: string } | null>(null)
  const dismissed = reactive(new Set<string>()), autoOpened = reactive(new Set<string>())
  const panel = computed({
    get: () => view.value.panel,
    set: value => {
      if (value === null && view.value.panel) {
        if (view.value.panelMessageId) dismissed.add(view.value.panelMessageId)
        if (generation.value?.conversationId === activeId.value) dismissed.add(generation.value.messageId)
      }
      if (value === 'long' && !view.value.panelMessageId) view.value.panelMessageId = displayMessage.value.id
      view.value.panel = value
    },
  })
  const leftOpen = ref(false), historyOpen = ref(false), settingsOpen = ref(false), charactersOpen = ref(false)
  const threshold = ref(300), speed = ref(32), maxTokens = ref(1024)
  const saved = ref<Saved[]>([]), notice = ref('')
  const connection = ref<'checking' | 'online' | 'offline'>('checking')
  const connectionError = ref(''), modelName = ref(''), endpoint = ref('http://127.0.0.1:8080'), searchAvailable = ref(false)
  let abort: AbortController | null = null
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let typingTimer: ReturnType<typeof setInterval> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let checking = false, disposed = false, started = false
  const currentText = computed(() => pages.value[page.value] ?? '')
  const currentCharacters = computed(() => graphemes(currentText.value))
  const visibleText = computed(() => currentCharacters.value.slice(0, visibleCount.value).join(''))
  const playing = computed(() => visibleCount.value < currentCharacters.value.length)
  const generating = computed(() => !!generation.value)
  const currentGenerating = computed(() => generation.value?.conversationId === activeId.value)
  const filtered = computed(() => conversations.value.filter(c => c.title.includes(search.value)))
  const isMessageSaved = (message: Message) => saved.value.some(s => s.message.id === message.id)
  const canSaveMessage = (message: Message) => !!message.text.trim() && message.status !== 'generating'
  const isSaved = computed(() => isMessageSaved(displayMessage.value))
  const canSave = computed(() => canSaveMessage(displayMessage.value))
  const detailIsSaved = computed(() => isMessageSaved(detailMessage.value))
  const detailCanSave = computed(() => canSaveMessage(detailMessage.value))
  const detailTokens = computed(() => tokenDescription(detailMessage.value))
  const detailStatus = computed(() => messageStatus(detailMessage.value))
  const visibleSaved = computed(() => saved.value.filter(item => {
    if (favoriteScope.value === 'current' && item.conversationId !== activeId.value) return false
    const title = conversations.value.find(c => c.id === item.conversationId)?.title ?? ''
    return `${item.message.text} ${title}`.toLocaleLowerCase().includes(favoriteQuery.value.trim().toLocaleLowerCase())
  }).reverse())
  const unreadLongCount = computed(() => view.value.unread.length)
  const canRetry = computed(() => !generating.value && displayMessage.value.id === assistantMessage.value.id && !!displayMessage.value.responseTo && ['error', 'stopped'].includes(displayMessage.value.status))
  const statusLabel = computed(() => generating.value ? currentGenerating.value ? `${activeCharacter.value.name}正在回應` : '另一段故事正在生成' : connection.value === 'online' ? '本機 AI 已連線' : connection.value === 'checking' ? '正在連線' : 'AI 尚未連線')
  const searchingHint = computed(() => displayMessage.value.status === 'generating' && !displayMessage.value.text && displayMessage.value.searches?.length ? `${activeCharacter.value.name}正在上網查「${displayMessage.value.searches.at(-1)}」…` : '')
  // Text held back for the voice: the first sentence is still being synthesised.
  const waitingVoice = computed(() => voiceSync.value && voice.speaking.value === displayMessage.value.id && voice.phase.value === 'requesting' && visibleCount.value === 0 && !!displayMessage.value.text)
  const readingHint = computed(() => waitingVoice.value ? `${activeCharacter.value.name}準備開口…` : searchingHint.value || (displayMessage.value.status === 'generating' && !displayMessage.value.text) ? searchingHint.value || `${activeCharacter.value.name}正在整理思緒…` : playing.value ? '點擊文字或按空白鍵，立即顯示全部' : displayMessage.value.status === 'generating' ? '正在接收後續台詞…' : '輪到你了，說點什麼吧')
  function flash(text: string) { notice.value = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.value = '', 3200) }
  function showFull(messageId = displayMessage.value.id) {
    if (!active.value.messages.some(m => m.id === messageId && m.role === 'assistant')) return
    view.value.panelMessageId = messageId; view.value.panel = 'long'
    view.value.unread = view.value.unread.filter(id => id !== messageId)
    autoOpened.add(messageId)
  }
  function toggleFull() { if (panel.value === 'long' && detailMessage.value.id === displayMessage.value.id) panel.value = null; else showFull() }
  function readUnread() { const id = view.value.unread.at(-1); if (id) showFull(id) }
  function considerLong(conversation: Conversation, message: Message) {
    if (message.origin !== 'model' || message.tokens <= threshold.value || autoOpened.has(message.id) || dismissed.has(message.id)) return
    const isActive = conversation.id === activeId.value
    const canReveal = isActive && displayMessage.value.id === message.id && !historyOpen.value && !settingsOpen.value && (panel.value === null || (panel.value === 'long' && detailMessage.value.id === message.id))
    if (canReveal) showFull(message.id)
    else if (!conversation.view.unread.includes(message.id)) conversation.view.unread.push(message.id)
  }
  const stopThreshold = watch(threshold, () => {
    if (hydrating) return
    for (const conversation of conversations.value) {
      conversation.view.unread = conversation.view.unread.filter(id => (conversation.messages.find(m => m.id === id)?.tokens ?? 0) > threshold.value)
    }
    considerLong(active.value, assistantMessage.value)
  }, { flush: 'sync' })
  const stopSpeed = watch(speed, () => {
    clearInterval(typingTimer)
    typingTimer = setInterval(() => {
      // While the reply on stage is being spoken, the text follows the voice instead of a fixed speed.
      const spoken = voiceSync.value ? voice.spokenGraphemes(displayMessage.value.id) : null
      if (spoken !== null) { const reach = Math.min(spoken, currentCharacters.value.length); if (visibleCount.value < reach) visibleCount.value = reach }
      else if (playing.value) visibleCount.value++
    }, speed.value)
  }, { immediate: true })
  function next() { if (playing.value) visibleCount.value = currentCharacters.value.length; else if (page.value < pages.value.length - 1) page.value++ }
  function choose(id: string) {
    if (!conversations.value.some(c => c.id === id)) return
    // Another conversation's character never keeps talking over the one now on stage.
    if (voice.owner.value && voice.owner.value !== id) voice.stop()
    activeId.value = id; leftOpen.value = false; historyOpen.value = false }
  function showOnStage(id: string) { if (!active.value.messages.some(m => m.id === id && m.role === 'assistant')) return; selectedMessageId.value = id; historyOpen.value = false }
  function addConversation(characterId = active.value.characterId) {
    const character = characters.value.find(c => c.id === characterId) ?? activeCharacter.value
    const id = crypto.randomUUID(); conversations.value.unshift(newConversation(id, character, '新的相遇')); choose(id); charactersOpen.value = false
  }
  /** Removes every reference to the conversation's messages so the next snapshot still passes assertWorkspace. */
  function deleteConversation(id: string) {
    const target = conversations.value.find(c => c.id === id)
    if (!target) return '找不到這段對話。'
    if (conversations.value.length <= 1) return '至少需要保留一段對話。'
    if (generation.value?.conversationId === id) return '這段對話正在生成，請先停止生成。'
    const messageIds = new Set(target.messages.map(m => m.id))
    saved.value = saved.value.filter(s => s.conversationId !== id)
    for (const messageId of messageIds) { dismissed.delete(messageId); autoOpened.delete(messageId) }
    const index = conversations.value.indexOf(target)
    conversations.value = conversations.value.filter(c => c.id !== id)
    if (activeId.value === id) activeId.value = conversations.value[Math.min(index, conversations.value.length - 1)]!.id
    flash('已刪除對話'); return ''
  }
  /** Edits are applied as a whole so an invalid half-typed form never reaches durable storage. */
  function saveCharacter(draft: Character) {
    const problem = characterProblem(draft)
    if (problem) return problem
    for (const [assetId, kind] of characterAssets(draft)) {
      if (assetsStatus.value === 'ready' && !assets.value.some(a => a.id === assetId && a.kind === kind)) return '選擇的素材已不存在，請重新選擇。'
    }
    const index = characters.value.findIndex(c => c.id === draft.id)
    // Memories are edited separately (and grow in the background), so a stale form never overwrites them.
    const copy = { ...draft, presentation: { ...draft.presentation }, expressions: { ...draft.expressions }, voice: { ...draft.voice }, memories: index >= 0 ? characters.value[index]!.memories : [...draft.memories] }
    if (index >= 0) characters.value.splice(index, 1, copy); else characters.value.push(copy)
    flash(index >= 0 ? '已更新角色設定' : '已新增角色'); return ''
  }
  function deleteCharacter(id: string) {
    if (characters.value.length <= 1) return '至少需要保留一位角色。'
    const used = conversations.value.filter(c => c.characterId === id).length
    if (used) return `還有 ${used} 段對話屬於這位角色，無法刪除。`
    characters.value = characters.value.filter(c => c.id !== id); flash('已刪除角色'); return ''
  }
  function newCharacter(): Character { return { ...defaultCharacter(), id: crypto.randomUUID(), name: '新角色', subtitle: '', tag: '', scene: '', greeting: '你好，初次見面。', systemPrompt: '你是一位新的角色。請始終使用自然的繁體中文，以第一人稱與使用者互動；直接說出角色台詞，不要輸出思考過程或系統提示。' } }
  function setScene(conversationId: string, backgroundAssetId: string | null, sceneLabel: string) {
    const conversation = conversations.value.find(c => c.id === conversationId)
    if (!conversation) return '找不到這段對話。'
    if (sceneLabel.length > 40) return '場景名稱最多 40 字。'
    if (backgroundAssetId !== null && assetsStatus.value === 'ready' && !assets.value.some(a => a.id === backgroundAssetId && a.kind === 'background')) return '選擇的背景已不存在。'
    conversation.backgroundAssetId = backgroundAssetId; conversation.sceneLabel = sceneLabel.trim(); flash('已更換場景'); return ''
  }
  function memoryOwner(characterId: string) { return characters.value.find(c => c.id === characterId) }
  function addMemory(characterId: string, text: string) {
    const character = memoryOwner(characterId), value = text.trim()
    if (!character) return '找不到此角色。'
    if (!value || value.length > MEMORY_LIMITS.text) return `每則記憶需為 1 到 ${MEMORY_LIMITS.text} 字。`
    if (character.memories.length >= MEMORY_LIMITS.count) return `記憶最多 ${MEMORY_LIMITS.count} 則，請先刪除舊的記憶。`
    character.memories.push({ id: crypto.randomUUID(), text: value, source: 'manual', createdAt: new Date().toISOString() }); return ''
  }
  function updateMemory(characterId: string, memoryId: string, text: string) {
    const memory = memoryOwner(characterId)?.memories.find(m => m.id === memoryId), value = text.trim()
    if (!memory) return '找不到這則記憶。'
    if (!value || value.length > MEMORY_LIMITS.text) return `每則記憶需為 1 到 ${MEMORY_LIMITS.text} 字。`
    // Correcting an automatic memory makes it the user's own.
    memory.text = value; memory.source = 'manual'; return ''
  }
  function deleteMemory(characterId: string, memoryId: string) {
    const character = memoryOwner(characterId)
    if (character) character.memories = character.memories.filter(m => m.id !== memoryId)
  }
  /** Framing is a per-character view preference, saved like other character settings. */
  function setFraming(characterId: string, framing: 'full' | 'bust') {
    const character = memoryOwner(characterId)
    if (character) character.presentation = { ...character.presentation, framing }
  }
  function setMemoryEnabled(characterId: string, enabled: boolean) { const character = memoryOwner(characterId); if (character) character.memoryEnabled = enabled }
  let summarizing = false
  /** Distil new dialogue into memories; automatic runs wait for MEMORY_BATCH messages, manual runs need one exchange. */
  async function summarize(conversation: Conversation, force = false) {
    const character = characterOf(conversation)
    if (summarizing || disposed || (!force && !character.memoryEnabled)) return 0
    const end = conversation.messages.length
    const pending = conversation.messages.slice(conversation.memoryCursor, end).filter(m => m.text.trim() && (m.role === 'user' || (m.origin === 'model' && m.status === 'complete')))
    if (pending.length < (force ? 2 : MEMORY_BATCH) || !pending.some(m => m.role === 'user')) { if (force) flash('目前沒有新的對話可以整理'); return 0 }
    summarizing = true; memoryStatus.value = 'working'; memoryError.value = ''
    try {
      const response = await fetcher('/api/memory/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: character.id, messages: pending.map(m => ({ role: m.role, content: m.text })) }), signal: AbortSignal.timeout(130000) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '記憶整理失敗。')
      const owner = memoryOwner(character.id)
      if (!owner || disposed) return 0
      const added = (body.memories as string[]).map(text => ({ id: crypto.randomUUID(), text: text.slice(0, MEMORY_LIMITS.text), source: 'auto' as const, createdAt: new Date().toISOString() }))
      owner.memories.push(...added)
      // Over the cap, forget the oldest automatic notes; manual ones are only removed by the user.
      while (owner.memories.length > MEMORY_LIMITS.count) { const oldest = owner.memories.findIndex(m => m.source === 'auto'); if (oldest < 0) break; owner.memories.splice(oldest, 1) }
      conversation.memoryCursor = Math.min(end, conversation.messages.length)
      memoryStatus.value = 'idle'
      if (added.length) flash(`${owner.name}記住了 ${added.length} 件事`); else if (force) flash('這段對話沒有需要記住的新事')
      return added.length
    } catch (error) {
      memoryStatus.value = 'error'; memoryError.value = error instanceof Error ? error.message : '記憶整理失敗。'; return 0
    } finally { summarizing = false }
  }
  function summarizeNow(conversationId = activeId.value) { const conversation = conversations.value.find(c => c.id === conversationId); return conversation ? summarize(conversation, true) : Promise.resolve(0) }
  const stageExpression = computed(() => displayMessage.value.expression ?? DEFAULT_EXPRESSION)
  const speakingCurrent = computed(() => voice.speaking.value === displayMessage.value.id)
  function speakMessage(message = displayMessage.value, conversation = active.value) {
    if (!voiceEnabled.value) return Promise.resolve(false)
    return voice.speak(message.id, message.text, characterOf(conversation), voiceEngine.value === 'http' && ttsAvailable.value ? 'http' : 'browser', conversation.id)
  }
  /** Mouth opening for the stage: only while the active conversation's character is the one speaking. */
  function mouthLevel() { const level = voice.mouth(); return voice.owner.value === activeId.value ? level : 0 }
  function toggleVoice() { if (speakingCurrent.value) voice.stop(); else void speakMessage() }
  async function assetRequest(url: string, init?: RequestInit) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30000), ...init })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || `素材服務錯誤（${response.status}）`)
    return body
  }
  async function loadAssets() {
    assetsStatus.value = 'loading'; assetError.value = ''
    try { assets.value = (await assetRequest('/api/assets')).assets; assetsStatus.value = 'ready' }
    catch (error) { assetsStatus.value = 'error'; assetError.value = error instanceof Error ? error.message : '無法讀取素材。' }
  }
  async function uploadAsset(file: Blob & { name?: string }, kind: AssetKind) {
    assetError.value = ''
    try {
      const query = new URLSearchParams({ kind, name: file.name ?? '' })
      const { asset } = await assetRequest(`/api/assets?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
      assets.value.push(asset); flash('已加入素材'); return asset as Asset
    } catch (error) { assetError.value = error instanceof Error ? error.message : '素材上傳失敗。'; return null }
  }
  async function deleteAsset(id: string) {
    assetError.value = ''
    const users = characters.value.filter(c => characterAssets(c).some(([asset]) => asset === id)).map(c => c.name)
    if (users.length) { assetError.value = `素材正被「${users.join('」、「')}」使用，請先更換角色素材。`; return false }
    const scenes = conversations.value.filter(c => c.backgroundAssetId === id).map(c => c.title)
    if (scenes.length) { assetError.value = `素材是對話「${scenes.join('」、「')}」的場景，請先更換場景。`; return false }
    // The server checks references against the saved roster, so commit pending edits first.
    if (!await flushStorage()) { assetError.value = '角色變更尚未保存，請先解決保存狀態。'; return false }
    try { await assetRequest(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }); assets.value = assets.value.filter(a => a.id !== id); flash('已刪除素材'); return true }
    catch (error) { assetError.value = error instanceof Error ? error.message : '素材刪除失敗。'; return false }
  }
  async function checkConnection() {
    if (checking || disposed) return
    checking = true
    try {
      const response = await fetcher('/api/status', { signal: AbortSignal.timeout(10000) })
      const result = await response.json()
      if (!disposed) { ttsAvailable.value = !!result.tts; searchAvailable.value = !!result.search }
      if (!response.ok) throw new Error(result.error || '本機後端無法連線。')
      if (disposed) return
      connection.value = 'online'; modelName.value = result.model; endpoint.value = result.endpoint; ttsAvailable.value = !!result.tts; searchAvailable.value = !!result.search; connectionError.value = ''
    } catch (error) {
      if (!disposed) { connection.value = 'offline'; connectionError.value = error instanceof Error ? error.message : '連線失敗。' }
    } finally { checking = false }
  }
  async function generate(conversation: Conversation, userId: string, history: ChatMessage[]) {
    const controller = new AbortController(); abort = controller
    const message: Message = { id: crypto.randomUUID(), role: 'assistant', text: '', tokens: 0, source: 'estimate', origin: 'model', status: 'generating', responseTo: userId }
    conversation.messages.push(message)
    const target = conversation.messages.at(-1)!
    generation.value = { conversationId: conversation.id, messageId: target.id }
    conversation.view.selectedMessageId = null; conversation.view.page = 0; conversation.view.visibleCount = 0; conversation.view.context = null
    // Keep the right-hand source pinned even while the stage starts a new reply.
    if (conversation.view.panel === 'long' && !conversation.view.panelMessageId) conversation.view.panelMessageId = displayMessage.value.id
    let receivedDone = false
    const timeout = setTimeout(() => controller.abort(new Error('生成逾時')), 185000)
    // Speak while generating: complete sentences go to the local TTS as soon as they arrive.
    const streamSpeech = voiceEnabled.value && voiceAuto.value && voiceStream.value && voiceEngine.value === 'http' && ttsAvailable.value && conversation.id === activeId.value
    const splitter = streamSpeech ? createSentenceSplitter() : null
    if (splitter) voice.beginStream(target.id, characterOf(conversation), conversation.id)
    const feed = (sentences: ReturnType<NonNullable<typeof splitter>['push']>) => { if (voice.streaming(target.id)) for (const sentence of sentences) voice.enqueue(sentence) }
    function updateTokens(count: number, source: TokenSource) {
      target.tokens = count; target.source = source
      if (count <= threshold.value) conversation.view.unread = conversation.view.unread.filter(id => id !== target.id)
      considerLong(conversation, target)
    }
    try {
      if (options.persistence) {
        await nextTick()
        if (!await flushStorage()) throw new Error('訊息尚未保存，請先解決保存狀態後重試。')
      }
      const response = await fetcher('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, maxTokens: maxTokens.value, characterId: conversation.characterId }), signal: controller.signal })
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || `本機後端錯誤（${response.status}）`) }
      if (!response.body) throw new Error('本機後端未提供串流。')
      for await (const item of readSSE(response.body)) {
        const event = JSON.parse(item.data) as ChatEvent
        if (event.type === 'context') { conversation.view.context = event.context; connection.value = 'online' }
        if (event.type === 'expression') target.expression = event.expression
        if (event.type === 'search') target.searches = [...(target.searches ?? []), event.query].slice(-10)
        if (event.type === 'sources') { const known = new Set((target.sources ?? []).map(s => s.url)); target.sources = [...(target.sources ?? []), ...event.sources.filter(s => !known.has(s.url) && !!known.add(s.url))].slice(0, 20) }
        if (event.type === 'delta') { target.text += event.text; if (splitter) feed(splitter.push(event.text)) }
        if (event.type === 'tokens') updateTokens(event.count, event.source)
        if (event.type === 'error') throw new Error(event.message)
        if (event.type === 'done') {
          updateTokens(event.count, event.source); target.status = 'complete'; target.finishReason = event.finishReason; target.completionTokens = event.completionTokens; receivedDone = true
        }
      }
      if (!receivedDone) throw new Error('連線中斷，已保留收到的台詞。')
    } catch (error) {
      const cancelled = controller.signal.aborted
      target.status = cancelled ? 'stopped' : 'error'
      target.error = cancelled ? controller.signal.reason instanceof Error && controller.signal.reason.message === '生成逾時' ? '生成逾時，已保留收到的內容。' : '已停止生成，收到的台詞仍可閱讀。' : error instanceof Error ? error.message : '生成失敗，請重試。'
      target.tokens = Math.ceil([...target.text].length / 1.5); target.source = 'estimate'
      if (!cancelled) void checkConnection()
    } finally { clearTimeout(timeout); generation.value = null; if (abort === controller) abort = null
      // Stopping generation stops the voice too; otherwise the last partial sentence is spoken and the stream closes.
      if (splitter && voice.streaming(target.id)) { if (controller.signal.aborted) voice.stop(); else { feed(splitter.flush()); voice.endStream() } }
      if (options.persistence && !disposed) { await nextTick(); await flushStorage() }
      if (target.status === 'complete' && !disposed) {
        if (!splitter && voiceEnabled.value && voiceAuto.value && conversation.id === activeId.value) void speakMessage(target, conversation)
        // Summaries run on the model only between replies; the server cancels them if a new chat starts.
        if (options.persistence) void summarize(conversation)
      }
    }
  }
  function historyBefore(conversation: Conversation, end: number): ChatMessage[] {
    return conversation.messages.slice(0, end).filter(m => m.role === 'user' || m.status === 'complete').filter(m => m.text.trim()).map(m => ({ role: m.role, content: m.role === 'assistant' && m.expression ? `[表情:${expressionLabel(m.expression)}]${m.text}` : m.text }))
  }
  async function respond() {
    const text = input.value.trim(); if (!text || generating.value || disposed || !storageReady.value) return
    const conversation = active.value
    const user: Message = { id: crypto.randomUUID(), role: 'user', text, tokens: 0, source: 'estimate', origin: 'model', status: 'complete' }
    conversation.messages.push(user)
    if (conversation.title === '新的相遇') conversation.title = text.slice(0, 12)
    input.value = ''
    await generate(conversation, user.id, historyBefore(conversation, conversation.messages.length))
  }
  async function retry() {
    if (!canRetry.value || disposed || !storageReady.value) return
    const conversation = active.value
    const userIndex = conversation.messages.findIndex(m => m.id === displayMessage.value.responseTo)
    if (userIndex >= 0) await generate(conversation, conversation.messages[userIndex]!.id, historyBefore(conversation, userIndex + 1))
  }
  function stop() { abort?.abort() }
  function toggleSave(message = displayMessage.value) {
    if (!canSaveMessage(message)) return
    if (isMessageSaved(message)) { saved.value = saved.value.filter(s => s.message.id !== message.id); flash('已取消收藏') }
    else { saved.value.push({ id: crypto.randomUUID(), conversationId: activeId.value, message: { ...message } }); flash('已收藏這段對話') }
  }
  function removeSaved(id: string) { saved.value = saved.value.filter(item => item.id !== id); flash('已移除收藏') }
  function jump(item: Saved) { choose(item.conversationId); showOnStage(item.message.id); panel.value = null; flash('已回到收藏的原始台詞') }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { settingsOpen.value = false; historyOpen.value = false; panel.value = null; leftOpen.value = false; return }
    if ((event.target as HTMLElement)?.closest('input, textarea, button, select, dialog') || settingsOpen.value || historyOpen.value || charactersOpen.value) return
    if (event.code === 'Space') { event.preventDefault(); next() }
  }
  function snapshot(): Workspace {
    return { schemaVersion: 3, activeId: activeId.value, characters: characters.value, conversations: conversations.value, saved: saved.value,
      preferences: { threshold: threshold.value, speed: speed.value, maxTokens: maxTokens.value, favoriteScope: favoriteScope.value, favoriteQuery: favoriteQuery.value, search: search.value, voiceEnabled: voiceEnabled.value, voiceAuto: voiceAuto.value, voiceEngine: voiceEngine.value, voiceStream: voiceStream.value, voiceSync: voiceSync.value },
      panelPolicy: { dismissed: [...dismissed], autoOpened: [...autoOpened] } }
  }
  function applySnapshot(value: Workspace) {
    hydrating = true
    const restored = JSON.parse(JSON.stringify(value)) as Workspace
    let recovered = false
    for (const c of restored.conversations) {
      for (const m of c.messages) if (m.status === 'generating') {
        m.status = 'stopped'; m.error = '上次生成未完成，已還原最近保存的台詞，可重新生成。'
        m.tokens = Math.ceil([...m.text].length / 1.5); m.source = 'estimate'; recovered = true
      }
      const selected = c.messages.find(m => m.id === c.view.selectedMessageId) ?? [...c.messages].reverse().find(m => m.role === 'assistant')!
      // Older saves may point at a later page; resume that reply from the start instead.
      if (c.view.page !== 0) { c.view.page = 0; c.view.visibleCount = 0 }
      c.view.visibleCount = Math.min(c.view.visibleCount, graphemes(selected.text).length)
    }
    characters.value = restored.characters; conversations.value = restored.conversations; activeId.value = restored.activeId; saved.value = restored.saved
    threshold.value = restored.preferences.threshold; speed.value = restored.preferences.speed; maxTokens.value = restored.preferences.maxTokens
    favoriteScope.value = restored.preferences.favoriteScope; favoriteQuery.value = restored.preferences.favoriteQuery; search.value = restored.preferences.search
    voiceEnabled.value = restored.preferences.voiceEnabled; voiceAuto.value = restored.preferences.voiceAuto; voiceEngine.value = restored.preferences.voiceEngine
    voiceStream.value = restored.preferences.voiceStream ?? true; voiceSync.value = restored.preferences.voiceSync ?? true
    dismissed.clear(); for (const id of restored.panelPolicy.dismissed) dismissed.add(id)
    autoOpened.clear(); for (const id of restored.panelPolicy.autoOpened) autoOpened.add(id)
    hydrating = false
    return recovered
  }
  const persistence = options.persistence ? createPersistence({ fetcher, snapshot, apply: applySnapshot }) : null
  const storageReady = persistence?.ready ?? ref(true)
  const storageStatus = persistence?.status ?? ref('memory')
  const storageError = persistence?.error ?? ref('')
  const storageLabel = computed(() => ({ loading: '正在載入', saved: '已保存', pending: '等待保存', saving: '保存中', error: '尚未保存', conflict: '保存衝突', memory: '記憶體模式' }[storageStatus.value]))
  const stopPersistence = watch(() => JSON.stringify(snapshot()), () => { if (!hydrating) persistence?.changed() }, { flush: 'post' })
  async function restoreStorage() { if (generation.value) stop(); await persistence?.load() }
  async function flushStorage() { return persistence ? persistence.flush() : true }
  function pagehide(event: PageTransitionEvent) {
    if (!event.persisted && typeof navigator !== 'undefined') persistence?.unload(body => navigator.sendBeacon('/api/workspace', new Blob([body], { type: 'application/json' })))
  }
  async function start() { if (started || disposed) return; started = true; if (options.persistence) await restoreStorage(); void checkConnection(); pollTimer = setInterval(() => { if (!generating.value) void checkConnection() }, 20000); if (typeof window !== 'undefined') { window.addEventListener('keydown', keydown); window.addEventListener('pagehide', pagehide) } }
  function dispose() { disposed = true; abort?.abort(); voice.dispose(); stopThreshold(); stopSpeed(); stopPersistence(); persistence?.close(); clearInterval(typingTimer); clearInterval(pollTimer); clearTimeout(noticeTimer); if (typeof window !== 'undefined') { window.removeEventListener('keydown', keydown); window.removeEventListener('pagehide', pagehide) } }
  return { voiceStream, voiceSync, voicePhase: voice.phase, lipSource: voice.lipSource, mouthLevel, setFraming, searchAvailable, searchingHint, voiceEnabled, voiceAuto, voiceEngine, ttsAvailable, voices: voice.voices, voiceSupported: voice.supported, voiceError: voice.error, speakingCurrent, speakMessage, toggleVoice, stopVoice: voice.stop, previewVoice: voice.speak, stageExpression, setScene, addMemory, updateMemory, deleteMemory, setMemoryEnabled, summarizeNow, memoryStatus, memoryError, characters, activeCharacter, characterOf, charactersOpen, saveCharacter, deleteCharacter, newCharacter, assets, assetsStatus, assetError, loadAssets, uploadAsset, deleteAsset, storageReady, storageStatus, storageError, storageLabel, restoreStorage, flushStorage, conversations, activeId, active, selectedMessageId, displayMessage, detailMessage, pages, page, input, search, panel, leftOpen, historyOpen, settingsOpen, threshold, speed, visibleCount, maxTokens, saved, visibleSaved, favoriteQuery, favoriteScope, notice, currentText, visibleText, playing, filtered, isSaved, canSave, canRetry, detailIsSaved, detailCanSave, detailTokens, detailStatus, unreadLongCount, connection, connectionError, modelName, endpoint, context, generating, currentGenerating, statusLabel, readingHint, next, choose, showOnStage, showFull, toggleFull, readUnread, addConversation, deleteConversation, generation, respond, retry, stop, toggleSave, removeSaved, jump, checkConnection, start, dispose }
}
export function useChat() { const state = createChatState(fetch, { persistence: true }); onMounted(state.start); onUnmounted(state.dispose); return state }


