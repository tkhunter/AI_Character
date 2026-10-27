import { nextTick, ref } from 'vue'
import { assertWorkspace } from '../../shared/workspace.ts'
import type { Workspace, WorkspaceEnvelope } from '../../shared/workspace.ts'

export function createPersistence(options: {
  fetcher: typeof fetch; snapshot: () => Workspace; apply: (snapshot: Workspace) => boolean
}) {
  const request = options.fetcher
  const ready = ref(false), status = ref<'loading' | 'saved' | 'pending' | 'saving' | 'error' | 'conflict'>('loading')
  const error = ref(''), revision = ref(0)
  let closed = false, loading = false, dirty = false, version = 0
  let lastSaved = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<boolean> | null = null
  let operation: { baseRevision: number; writeId: string; snapshot: Workspace; version: number } | null = null
  function schedule() { if (!timer && status.value !== 'error' && status.value !== 'conflict') timer = setTimeout(() => { timer = undefined; void flush() }, 300) }
  function changed() {
    if (!ready.value || loading || closed) return
    dirty = true; version++
    if (status.value !== 'error' && status.value !== 'conflict') { if (!running) status.value = 'pending'; schedule() }
  }
  async function load() {
    if (loading || closed) return
    loading = true; ready.value = false; status.value = 'loading'; error.value = ''; clearTimeout(timer); timer = undefined
    if (running) await running
    try {
      const response = await request('/api/workspace', { signal: AbortSignal.timeout(10000) })
      const body = await response.json() as WorkspaceEnvelope & { error?: string }
      if (!response.ok) throw new Error(body.error || '無法讀取本機保存資料。')
      if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('保存版本資料不正確。')
      if (body.snapshot !== null) assertWorkspace(body.snapshot)
      if (closed) return
      const recovered = options.apply(body.snapshot ?? options.snapshot())
      await nextTick()
      revision.value = body.revision; operation = null; dirty = false; lastSaved = JSON.stringify(options.snapshot()); ready.value = true; status.value = 'saved'
      loading = false
      if (body.snapshot === null || recovered) changed()
    } catch (cause) {
      if (!closed) { status.value = 'error'; error.value = cause instanceof Error ? cause.message : '無法載入保存資料，請重試。' }
    } finally { loading = false }
  }
  async function attempt() {
    status.value = 'saving'; error.value = ''
    try {
      if (!operation) {
        const candidate = { baseRevision: revision.value, writeId: crypto.randomUUID(), snapshot: JSON.parse(JSON.stringify(options.snapshot())) as Workspace, version }
        assertWorkspace(candidate.snapshot)
        operation = candidate
      }
      const response = await request('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10000) })
      const body = await response.json()
      if (!response.ok) {
        status.value = response.status === 409 ? 'conflict' : 'error'
        if ([400, 413, 415].includes(response.status)) operation = null
        throw new Error(body.error || '本機保存失敗，請重試。')
      }
      if (body.revision !== operation.baseRevision + 1) throw new Error('保存版本回應不正確，請重試。')
      revision.value = body.revision; dirty = version !== operation.version; lastSaved = JSON.stringify(operation.snapshot); operation = null
      status.value = dirty ? 'pending' : 'saved'
      return true
    } catch (cause) {
      if (status.value !== 'conflict') status.value = 'error'
      error.value = cause instanceof Error ? cause.message : '本機保存失敗，請重試。'
      return false
    }
  }
  async function flush(): Promise<boolean> {
    await nextTick()
    clearTimeout(timer); timer = undefined
    if (!ready.value || closed || loading || status.value === 'conflict') return false
    if (running) {
      const ok = await running
      if (!ok) return false
      return dirty ? flush() : true
    }
    if (!dirty && !operation) return true
    running = attempt()
    const ok = await running
    running = null
    if (ok && dirty) schedule()
    return ok
  }
  function unload(send: (body: string) => boolean) {
    // A checkpoint already in flight stays authoritative; never guess its revision.
    if (!ready.value || loading || closed || running || operation || status.value === 'conflict' || status.value === 'error') return
    if (!dirty && JSON.stringify(options.snapshot()) === lastSaved) return
    const body = JSON.stringify({ baseRevision: revision.value, writeId: crypto.randomUUID(), snapshot: options.snapshot() })
    if (new TextEncoder().encode(body).length <= 60000) send(body)
  }
  function close() { closed = true; clearTimeout(timer) }
  return { ready, status, error, revision, changed, load, flush, unload, close }
}
