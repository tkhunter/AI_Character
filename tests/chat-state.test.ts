import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createChatState } from '../src/composables/useChat.ts'
import { characters, messageStatus, splitDialogue } from '../src/chat/model.ts'
import type { ChatEvent } from '../shared/protocol.ts'

function harness() {
  const requests: { messages: { role: string; content: string }[]; maxTokens: number }[] = []
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const fetcher: typeof fetch = async (url, init) => {
    if (url === '/api/status') return Response.json({ connected: true, model: 'test', endpoint: 'http://127.0.0.1:8080' })
    requests.push(JSON.parse(init!.body as string))
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      streams.push(controller)
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Cancelled', 'AbortError')), { once: true })
    } })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const chat = createChatState(fetcher)
  function emit(event: ChatEvent, index = streams.length - 1) { streams[index]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) }
  async function flush() { await setImmediate() }
  async function finish(count = 400, index = streams.length - 1) { emit({ type: 'done', count, source: 'tokenizer', finishReason: 'stop' }, index); streams[index]!.close(); await flush() }
  function send(text = '你好') { chat.input.value = text; return chat.respond() }
  return { chat, streams, requests, emit, flush, finish, send }
}

test('strict threshold, one auto-open, manual close and changed thresholds do not reopen a reply', async () => {
  const h = harness()
  try {
    const task = h.send(); await h.flush()
    h.emit({ type: 'delta', text: '測試台詞' }); h.emit({ type: 'tokens', count: 300, source: 'tokenizer' }); await h.flush()
    assert.equal(h.chat.panel.value, null)
    h.emit({ type: 'tokens', count: 301, source: 'tokenizer' }); await h.flush(); assert.equal(h.chat.panel.value, 'long')
    h.chat.panel.value = null
    h.emit({ type: 'tokens', count: 600, source: 'tokenizer' }); await h.flush()
    h.chat.threshold.value = 150
    assert.equal(h.chat.panel.value, null)
    await h.finish(600); await task; assert.equal(h.chat.panel.value, null)
  } finally { h.chat.dispose() }
})

test('lowering threshold opens a newly eligible reply; exact equality still stays closed', async () => {
  const h = harness()
  try {
    h.chat.threshold.value = 500
    const task = h.send(); h.emit({ type: 'delta', text: '已完成的台詞' }); await h.finish(300); await task
    h.chat.threshold.value = 300; assert.equal(h.chat.panel.value, null)
    h.chat.threshold.value = 150; assert.equal(h.chat.panel.value, 'long')
  } finally { h.chat.dispose() }
})

test('background completion keeps active draft, source and context, and offers unread long text', async () => {
  const h = harness()
  try {
    h.chat.addConversation(); const second = h.chat.activeId.value
    h.chat.input.value = '第二段故事草稿'; h.chat.showFull()
    const secondSource = h.chat.detailMessage.value.id
    h.chat.choose('first')
    const task = h.send('第一段故事'); h.chat.input.value = '第一段後續草稿'
    h.chat.choose(second)
    h.emit({ type: 'context', context: { promptTokens: 650, source: 'tokenizer', droppedMessages: 2, contextLimit: 8192 } })
    h.emit({ type: 'delta', text: '背景生成的完整長文' }); await h.finish(); await task
    assert.equal(h.chat.input.value, '第二段故事草稿'); assert.equal(h.chat.detailMessage.value.id, secondSource)
    assert.equal(h.chat.context.value, null); assert.equal(h.chat.panel.value, 'long')
    h.chat.choose('first'); assert.equal(h.chat.active.value.view.context?.promptTokens, 650)
    assert.equal(h.chat.input.value, '第一段後續草稿'); assert.equal(h.chat.panel.value, null)
    assert.equal(h.chat.unreadLongCount.value, 1)
    h.chat.readUnread(); assert.equal(h.chat.detailMessage.value.text, '背景生成的完整長文'); assert.equal(h.chat.unreadLongCount.value, 0)
  } finally { h.chat.dispose() }
})

test('reading position, visible characters and draft resume independently for each conversation', async () => {
  const h = harness()
  try {
    const task = h.send(); h.emit({ type: 'delta', text: '甲'.repeat(260) }); await h.finish(100); await task
    assert.equal(h.chat.pages.value.length, 1, 'a long reply plays as one continuous page'); h.chat.page.value = 1; assert.equal(h.chat.page.value, 0)
    h.chat.visibleCount.value = 207; h.chat.input.value = '第一則草稿'
    h.chat.addConversation(); h.chat.input.value = '第二則草稿'; const second = h.chat.activeId.value
    h.chat.choose('first'); assert.equal(h.chat.visibleCount.value, 207); assert.equal(h.chat.input.value, '第一則草稿')
    h.chat.choose(second); assert.equal(h.chat.visibleCount.value, 0); assert.equal(h.chat.input.value, '第二則草稿')
  } finally { h.chat.dispose() }
})

test('reading favorites or a pinned older source is never replaced by a new long reply', async () => {
  const h = harness()
  try {
    h.chat.showFull(); const source = h.chat.detailMessage.value.id
    const task = h.send(); h.emit({ type: 'delta', text: '新的長文' }); await h.finish(); await task
    assert.equal(h.chat.detailMessage.value.id, source); assert.equal(h.chat.unreadLongCount.value, 1)
    h.chat.panel.value = 'saved'
    h.chat.panel.value = 'long'; assert.equal(h.chat.detailMessage.value.id, source)
    h.chat.panel.value = 'saved'
    const another = h.send('下一個問題'); h.emit({ type: 'delta', text: '又一段長文' }); await h.finish(); await another
    assert.equal(h.chat.panel.value, 'saved'); assert.equal(h.chat.unreadLongCount.value, 2)
    h.chat.threshold.value = 500; assert.equal(h.chat.unreadLongCount.value, 0)
  } finally { h.chat.dispose() }
})

test('stopped replies can be saved as immutable partial snapshots; retry does not duplicate user input', async () => {
  const h = harness()
  try {
    const task = h.send('重試同一個問題'); await h.flush()
    h.emit({ type: 'delta', text: '只收到一半的話' }); await h.flush()
    assert.equal(h.chat.canSave.value, false)
    h.chat.stop(); await task
    assert.equal(h.chat.canRetry.value, true); assert.equal(h.chat.displayMessage.value.status, 'stopped')
    h.chat.toggleSave(); const original = h.chat.saved.value[0]!
    assert.match(messageStatus(original.message), /部分內容/)
    const retryTask = h.chat.retry(); h.emit({ type: 'delta', text: '重新生成後的完整台詞' }); await h.finish(50); await retryTask
    assert.equal(h.chat.active.value.messages.filter(m => m.role === 'user').length, 1)
    assert.equal(h.requests[1]!.messages.filter(m => m.role === 'user').length, 1)
    assert.ok(!h.requests[1]!.messages.some(m => m.content === '只收到一半的話'))
    assert.equal(original.message.text, '只收到一半的話'); assert.equal(original.message.status, 'stopped')
    h.chat.jump(original); assert.equal(h.chat.displayMessage.value.id, original.message.id); assert.equal(h.chat.panel.value, null)
  } finally { h.chat.dispose() }
})

test('failed partial replies remain readable and retryable without polluting model context', async () => {
  const h = harness()
  try {
    const task = h.send(); h.emit({ type: 'delta', text: '中斷前的文字' }); h.emit({ type: 'error', message: '模型斷線' }); await task
    assert.equal(h.chat.displayMessage.value.status, 'error'); assert.equal(h.chat.displayMessage.value.text, '中斷前的文字')
    assert.equal(h.chat.canRetry.value, true)
    const retryTask = h.chat.retry(); h.emit({ type: 'delta', text: '恢復了' }); await h.finish(10); await retryTask
    assert.equal(h.chat.displayMessage.value.status, 'complete'); assert.ok(!h.requests[1]!.messages.some(m => m.content === '中斷前的文字'))
  } finally { h.chat.dispose() }
})

test('favorites search, per-conversation filtering, cross-conversation source jump and removal', async () => {
  const h = harness()
  try {
    h.chat.toggleSave(); const first = h.chat.saved.value[0]!
    h.chat.addConversation(); const second = h.chat.activeId.value
    const task = h.send('貓咪書店'); h.emit({ type: 'delta', text: '貓咪在看一本新書' }); await h.finish(25); await task; h.chat.toggleSave()
    h.chat.favoriteQuery.value = '貓咪'; assert.equal(h.chat.visibleSaved.value.length, 1)
    h.chat.favoriteQuery.value = '雨後的書店'; assert.equal(h.chat.visibleSaved.value[0]?.id, first.id)
    h.chat.favoriteQuery.value = ''; h.chat.favoriteScope.value = 'current'; assert.equal(h.chat.visibleSaved.value.length, 1)
    h.chat.jump(first); assert.equal(h.chat.activeId.value, 'first'); assert.equal(h.chat.displayMessage.value.id, first.message.id)
    assert.equal(h.chat.visibleSaved.value.length, 1)
    h.chat.removeSaved(first.id); assert.equal(h.chat.visibleSaved.value.length, 0)
    h.chat.favoriteScope.value = 'all'; assert.equal(h.chat.visibleSaved.value[0]?.conversationId, second)
  } finally { h.chat.dispose() }
})

test('stream append preserves previous pages and grapheme-safe text without breaking emoji', async () => {
  const prefix = '甲'.repeat(114) + '👩‍💻' + '乙'.repeat(120)
  const before = splitDialogue(prefix), after = splitDialogue(prefix + '接著繼續說話。'.repeat(20))
  assert.equal(before[0], after[0]); assert.equal(before[1], after[1]); assert.equal(before.join(''), prefix)
  assert.equal(characters('👩‍💻🌧️你好').length, 4)
  const h = harness()
  try {
    const task = h.send(); h.emit({ type: 'delta', text: '👩‍💻🌧️你好' }); await h.flush()
    h.chat.visibleCount.value = 1; assert.equal(h.chat.visibleText.value, '👩‍💻')
    h.emit({ type: 'delta', text: '，新台詞' }); await h.flush(); assert.equal(h.chat.visibleCount.value, 1)
    await h.finish(20); await task
  } finally { h.chat.dispose() }
})

test('corrected final token counts remove stale unread notices', async () => {
  const h = harness()
  try {
    h.chat.panel.value = 'saved'
    const task = h.send(); h.emit({ type: 'delta', text: '完成時重新計數' }); h.emit({ type: 'tokens', count: 301, source: 'estimate' }); await h.flush()
    assert.equal(h.chat.unreadLongCount.value, 1)
    await h.finish(299); await task; assert.equal(h.chat.unreadLongCount.value, 0)
  } finally { h.chat.dispose() }
})


test('deleting a conversation removes its favorites, switches away from it and keeps the last one', async () => {
  const h = harness()
  try {
    assert.match(h.chat.deleteConversation('first'), /至少需要保留一段對話/)
    h.chat.toggleSave(); const kept = h.chat.saved.value[0]!
    h.chat.addConversation(); const second = h.chat.activeId.value
    h.chat.toggleSave(); assert.equal(h.chat.saved.value.length, 2)
    assert.equal(h.chat.deleteConversation(second), '')
    assert.deepEqual(h.chat.conversations.value.map(c => c.id), ['first'])
    assert.equal(h.chat.activeId.value, 'first'); assert.equal(h.chat.active.value.id, 'first')
    assert.deepEqual(h.chat.saved.value.map(s => s.id), [kept.id])
    assert.match(h.chat.deleteConversation('first'), /至少需要保留一段對話/)
    assert.match(h.chat.deleteConversation('missing'), /找不到/)
  } finally { h.chat.dispose() }
})

test('a conversation that is still generating cannot be deleted, even from the background', async () => {
  const h = harness()
  try {
    h.chat.addConversation(); const second = h.chat.activeId.value
    const task = h.send(); await h.flush()
    assert.match(h.chat.deleteConversation(second), /正在生成/)
    h.chat.choose('first'); assert.match(h.chat.deleteConversation(second), /正在生成/)
    assert.equal(h.chat.conversations.value.length, 2)
    h.emit({ type: 'delta', text: '完成了' }); await h.finish(10); await task
    assert.equal(h.chat.deleteConversation(second), ''); assert.equal(h.chat.activeId.value, 'first')
  } finally { h.chat.dispose() }
})
