import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { nextTick } from 'vue'
import { WorkspaceStore, StorageConflict } from '../server/storage.ts'
import { createApp } from '../server/app.ts'
import { LlamaClient } from '../server/llama.ts'
import { createChatState } from '../src/composables/useChat.ts'
import { createPersistence } from '../src/chat/persistence.ts'
import { createView } from '../src/chat/model.ts'
import { assertWorkspace } from '../shared/workspace.ts'
import { defaultVoicePreferences } from '../shared/workspace.ts'
import type { Workspace } from '../shared/workspace.ts'
import { defaultCharacter } from '../shared/characters.ts'

function fixture(): Workspace {
  const reply = { id: 'a1', role: 'assistant' as const, text: '測試台詞。'.repeat(60), tokens: 400, source: 'tokenizer' as const, origin: 'model' as const, status: 'complete' as const, responseTo: 'u1' }
  return { schemaVersion: 3, activeId: 'c1', characters: [defaultCharacter()], conversations: [{ id: 'c1', backgroundAssetId: null, sceneLabel: '', memoryCursor: 0, characterId: 'mio', title: '保存測試', time: '剛剛', messages: [
    { id: 'opening', role: 'assistant', text: '你好', tokens: 0, source: 'estimate', origin: 'opening', status: 'complete' },
    { id: 'u1', role: 'user', text: '請說故事', tokens: 0, source: 'estimate', origin: 'model', status: 'complete' }, reply,
  ], view: { ...createView(), draft: '尚未送出的草稿', page: 1, visibleCount: 5, selectedMessageId: 'a1', panel: 'long', panelMessageId: 'a1', unread: ['a1'] } }],
  saved: [{ id: 's1', conversationId: 'c1', message: { ...reply } }], preferences: { threshold: 300, speed: 55, maxTokens: 512, favoriteScope: 'current', favoriteQuery: '台詞', search: '', ...defaultVoicePreferences() }, panelPolicy: { dismissed: ['a1'], autoOpened: ['a1'] } }
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'shiori-sqlite-test-'))
  return { path: join(root, 'workspace.sqlite'), cleanup: async () => {
    const absolute = resolve(root), parent = resolve(tmpdir()) + sep
    assert.ok(absolute.startsWith(parent) && absolute.slice(parent.length).startsWith('shiori-sqlite-test-'))
    await rm(absolute, { recursive: true, force: true })
  } }
}
function transport(getStore: () => WorkspaceStore): typeof fetch {
  return async (url, init) => {
    if (url === '/api/status') return Response.json({ connected: true, model: 'test', endpoint: 'http://127.0.0.1:8080' })
    if (url !== '/api/workspace') throw new Error('Unexpected request')
    if (!init?.method) return Response.json(getStore().read())
    const body = JSON.parse(init.body as string)
    try { return Response.json({ revision: getStore().save(body.baseRevision, body.writeId, body.snapshot) }) }
    catch (error) { return Response.json({ error: (error as Error).message }, { status: error instanceof StorageConflict ? 409 : 500 }) }
  }
}

test('SQLite disk reopen restores the complete graph, order, snapshots, preferences and views', async () => {
  const dir = await directory(); let store = new WorkspaceStore(dir.path)
  try {
    const value = fixture(); assert.equal(store.save(0, 'first-write', value), 1)
    store.close(); store = new WorkspaceStore(dir.path)
    assert.deepEqual(store.read(), { revision: 1, snapshot: value })
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get()!.n, 3)
    value.saved = []; value.preferences.speed = 12
    store.save(1, 'remove-favorite', value)
    assert.equal(store.read().snapshot!.saved.length, 0); assert.equal(store.read().snapshot!.preferences.speed, 12)
    assert.equal(store.read().snapshot!.conversations[0]!.messages.length, 3)
  } finally { store.close(); await dir.cleanup() }
})

test('cross-connection stale revisions are rejected; lost-ack retries are idempotent', async () => {
  const dir = await directory(); const first = new WorkspaceStore(dir.path), second = new WorkspaceStore(dir.path)
  try {
    first.save(0, 'request-1', fixture())
    assert.throws(() => second.save(0, 'stale-tab', fixture()), StorageConflict)
    assert.equal(first.save(0, 'request-1', fixture()), 1)
    assert.equal(second.read().revision, 1)
  } finally { first.close(); second.close(); await dir.cleanup() }
})

test('failed SQL writes roll back the entire graph and revision; invalid references never reach SQL', () => {
  const store = new WorkspaceStore(':memory:')
  try {
    const original = fixture(); store.save(0, 'initial', original)
    store.db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;")
    const changed = structuredClone(original); changed.preferences.speed = 12; changed.conversations[0]!.messages[2]!.text = '改過的台詞'
    assert.throws(() => store.save(1, 'failed', changed), /simulated disk failure/)
    assert.deepEqual(store.read(), { revision: 1, snapshot: original })
    const bad = structuredClone(original); bad.saved[0]!.conversationId = 'missing'
    assert.throws(() => store.save(1, 'bad-ref', bad), /來源關聯/)
    assert.equal(store.read().revision, 1)
  } finally { store.close() }
})

test('workspace API loads, saves, validates, accepts unload checkpoints and rejects conflicts', async () => {
  const store = new WorkspaceStore(':memory:'), app = createApp(new LlamaClient('http://127.0.0.1:9'), store)
  app.listen(0, '127.0.0.1'); await once(app, 'listening')
  const address = app.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}/api/workspace`
  const save = (method: string, body: unknown) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.deepEqual(await (await fetch(url)).json(), { revision: 0, snapshot: null })
    const body = { baseRevision: 0, writeId: 'api-1', snapshot: fixture() }
    assert.equal((await save('PUT', body)).status, 200)
    assert.equal((await save('PUT', { ...body, writeId: 'stale' })).status, 409)
    assert.equal((await save('POST', { ...body, baseRevision: 1, writeId: 'unload-2' })).status, 200)
    assert.equal((await save('PUT', { ...body, baseRevision: 2, writeId: 'invalid', snapshot: {} })).status, 400)
    assert.equal(store.read().revision, 2)
  } finally { app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); store.close() }
})

test('frontend saves to disk and restores drafts, favorites, active conversation and settings in a fresh instance', async () => {
  const dir = await directory(); let store = new WorkspaceStore(dir.path)
  const fetcher = transport(() => store)
  const first = createChatState(fetcher, { persistence: true })
  let second: ReturnType<typeof createChatState> | undefined
  try {
    await first.restoreStorage(); assert.equal(first.storageReady.value, true)
    first.threshold.value = 500; first.speed.value = 55; first.maxTokens.value = 2048
    first.addConversation(); const id = first.activeId.value
    first.input.value = '重開仍在的草稿'; first.toggleSave(); first.panel.value = 'saved'
    assert.equal(await first.flushStorage(), true)
    first.dispose(); store.close(); store = new WorkspaceStore(dir.path)
    second = createChatState(fetcher, { persistence: true }); await second.restoreStorage()
    assert.equal(second.activeId.value, id); assert.equal(second.input.value, '重開仍在的草稿')
    assert.equal(second.saved.value.length, 1); assert.equal(second.panel.value, 'saved')
    assert.equal(second.threshold.value, 500); assert.equal(second.speed.value, 55); assert.equal(second.maxTokens.value, 2048)
    assert.equal(second.storageStatus.value, 'saved')
  } finally { first.dispose(); second?.dispose(); store.close(); await dir.cleanup() }
})

test('interrupted generation restores as stopped, preserves partial text and remains retryable', async () => {
  const store = new WorkspaceStore(':memory:'); const value = fixture()
  value.conversations[0]!.messages[2]!.status = 'generating'; value.conversations[0]!.messages[2]!.text = '尚未完成的部分內容'
  store.save(0, 'unfinished', value)
  const chat = createChatState(transport(() => store), { persistence: true })
  try {
    await chat.restoreStorage()
    assert.equal(chat.displayMessage.value.status, 'stopped'); assert.equal(chat.displayMessage.value.text, '尚未完成的部分內容')
    assert.equal(chat.displayMessage.value.source, 'estimate'); assert.equal(chat.canRetry.value, true); assert.equal(chat.generating.value, false)
    assert.equal(chat.page.value, 0)
    await chat.flushStorage()
    assert.equal(store.read().snapshot!.conversations[0]!.messages[2]!.status, 'stopped')
    assert.equal(chat.saved.value[0]!.message.status, 'complete')
  } finally { chat.dispose(); store.close() }
})

test('load failure never initializes over existing data, and conflict never silently overwrites another client', async () => {
  const store = new WorkspaceStore(':memory:'); store.save(0, 'seed', fixture())
  let offline = true
  const base = transport(() => store)
  const fetcher: typeof fetch = async (...args) => { if (offline) throw new Error('offline'); return base(...args) }
  const first = createChatState(fetcher, { persistence: true }), second = createChatState(base, { persistence: true })
  try {
    await first.restoreStorage(); assert.equal(first.storageReady.value, false); assert.equal(await first.flushStorage(), false)
    assert.equal(store.read().revision, 1)
    offline = false; await first.restoreStorage(); await second.restoreStorage()
    first.input.value = '視窗一'; await first.flushStorage()
    second.input.value = '視窗二'; assert.equal(await second.flushStorage(), false); assert.equal(second.storageStatus.value, 'conflict')
    assert.equal(store.read().snapshot!.conversations[0]!.view.draft, '視窗一')
    await second.restoreStorage(); assert.equal(second.input.value, '視窗一')
  } finally { first.dispose(); second.dispose(); store.close() }
})

test('network loss after a committed save retries the same write ID before saving newer changes', async () => {
  const store = new WorkspaceStore(':memory:'); let dropAck = true
  const base = transport(() => store)
  const fetcher: typeof fetch = async (url, init) => {
    const result = await base(url, init)
    if (init?.method === 'PUT' && dropAck) { dropAck = false; throw new Error('lost acknowledgement') }
    return result
  }
  const chat = createChatState(fetcher, { persistence: true })
  try {
    await chat.restoreStorage(); assert.equal(await chat.flushStorage(), false); assert.equal(store.read().revision, 1)
    chat.input.value = '失敗後的新草稿'; assert.equal(await chat.flushStorage(), true)
    await chat.flushStorage()
    assert.equal(store.read().revision, 2); assert.equal(store.read().snapshot!.conversations[0]!.view.draft, '失敗後的新草稿')
  } finally { chat.dispose(); store.close() }
})

test('generation starts only after its input checkpoint is saved and final text is committed', async () => {
  const store = new WorkspaceStore(':memory:'); const base = transport(() => store)
  const fetcher: typeof fetch = async (url, init) => {
    if (url === '/api/chat') {
      const snapshot = store.read().snapshot!; assertWorkspace(snapshot)
      assert.equal(snapshot.conversations[0]!.messages.at(-1)!.status, 'generating')
      assert.equal(snapshot.conversations[0]!.messages.at(-2)!.text, '先保存再生成')
      return new Response('data: {"type":"delta","text":"已完整生成"}\n\ndata: {"type":"done","count":6,"source":"tokenizer","finishReason":"stop"}\n\n')
    }
    return base(url, init)
  }
  const chat = createChatState(fetcher, { persistence: true })
  try {
    await chat.restoreStorage(); chat.input.value = '先保存再生成'; await chat.respond(); await nextTick()
    const message = store.read().snapshot!.conversations[0]!.messages.at(-1)!
    assert.equal(message.text, '已完整生成'); assert.equal(message.status, 'complete')
    assert.equal(chat.storageStatus.value, 'saved')
  } finally { chat.dispose(); store.close() }
})

test('unchanged pages do not send redundant unload writes; pending changes use the known revision', async () => {
  const store = new WorkspaceStore(':memory:'); store.save(0, 'seed', fixture())
  let value = fixture(), sent = 0
  const persistence = createPersistence({ fetcher: transport(() => store), snapshot: () => value, apply: snapshot => { value = snapshot; return false } })
  try {
    await persistence.load(); persistence.unload(() => { sent++; return true }); assert.equal(sent, 0)
    value.conversations[0]!.view.draft = '最後的草稿'; persistence.changed()
    persistence.unload(body => { const checkpoint = JSON.parse(body); assert.equal(checkpoint.baseRevision, 1); assert.equal(checkpoint.snapshot.conversations[0].view.draft, '最後的草稿'); sent++; return true })
    assert.equal(sent, 1)
  } finally { persistence.close(); store.close() }
})

test('validation failures can save corrected data instead of endlessly retrying an invalid snapshot', async () => {
  const store = new WorkspaceStore(':memory:'); store.save(0, 'seed', fixture())
  let value = fixture()
  const persistence = createPersistence({ fetcher: transport(() => store), snapshot: () => value, apply: snapshot => { value = snapshot; return false } })
  try {
    await persistence.load(); value.conversations[0]!.view.draft = 'x'.repeat(12001); persistence.changed()
    assert.equal(await persistence.flush(), false); assert.equal(store.read().revision, 1)
    value.conversations[0]!.view.draft = '已修正'; persistence.changed()
    assert.equal(await persistence.flush(), true); assert.equal(store.read().snapshot!.conversations[0]!.view.draft, '已修正')
  } finally { persistence.close(); store.close() }
})

test('deleted conversations leave no favorites or panel policy behind on disk, and free their character', async () => {
  const dir = await directory(); let store = new WorkspaceStore(dir.path)
  const fetcher = transport(() => store)
  const first = createChatState(fetcher, { persistence: true })
  let second: ReturnType<typeof createChatState> | undefined
  try {
    await first.restoreStorage()
    const keptOpening = first.displayMessage.value.id
    first.toggleSave(); first.showFull(); first.panel.value = null
    const guest = first.newCharacter(); assert.equal(first.saveCharacter(guest), '')
    first.addConversation(guest.id); const doomed = first.activeId.value, doomedOpening = first.displayMessage.value.id
    first.toggleSave(); first.showFull(); first.panel.value = null
    assert.equal(await first.flushStorage(), true)
    const before = store.read().snapshot!
    assert.ok(before.panelPolicy.dismissed.includes(doomedOpening) && before.panelPolicy.autoOpened.includes(doomedOpening))
    assert.match(first.deleteCharacter(guest.id), /還有 1 段對話/)

    assert.equal(first.deleteConversation(doomed), ''); assert.equal(first.activeId.value, 'first')
    assert.equal(await first.flushStorage(), true)
    first.dispose(); store.close(); store = new WorkspaceStore(dir.path)
    const after = store.read().snapshot!
    assertWorkspace(after)
    assert.deepEqual(after.conversations.map(c => c.id), ['first']); assert.equal(after.activeId, 'first')
    assert.deepEqual(after.saved.map(s => s.message.id), [keptOpening])
    assert.deepEqual(after.panelPolicy, { dismissed: [keptOpening], autoOpened: [keptOpening] })

    second = createChatState(fetcher, { persistence: true }); await second.restoreStorage()
    assert.deepEqual(second.conversations.value.map(c => c.id), ['first']); assert.equal(second.saved.value.length, 1)
    assert.equal(second.deleteCharacter(guest.id), '')
    assert.equal(await second.flushStorage(), true)
    assert.deepEqual(store.read().snapshot!.characters.map(c => c.id), ['mio'])
  } finally { first.dispose(); second?.dispose(); store.close(); await dir.cleanup() }
})
