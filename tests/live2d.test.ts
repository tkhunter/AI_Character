import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { CORE_URL, DEFAULT_MODEL, RUNTIME_URL, inspectInstallation, modelPath, parseManifest, resourcePath } from '../src/live2d/model.ts'
import { createActorSlot } from '../src/live2d/loader.ts'
import type { LiveActor } from '../src/live2d/loader.ts'

test('Live2D entries and resource references stay inside their local model package', () => {
  assert.equal(modelPath(DEFAULT_MODEL), DEFAULT_MODEL)
  assert.equal(resourcePath(DEFAULT_MODEL, 'Haru.2048/texture_00.png'), '/live2d/local/models/Haru/Haru.2048/texture_00.png')
  assert.equal(resourcePath(DEFAULT_MODEL, './Haru.moc3'), '/live2d/local/models/Haru/Haru.moc3')
  for (const path of ['https://example.com/Haru.model3.json', '/api/assets/abc', '/live2d/local/models/../Haru.model3.json', '/live2d/local/models/%2e%2e/Haru.model3.json', '/live2d/local/models/Haru/Haru.model3.json?remote=1', '/live2d/local/models/%252e%252e/Haru.model3.json']) assert.throws(() => modelPath(path))
  for (const path of ['../Other/Haru.moc3', '%2e%2e/Core.js', 'https://example.com/texture.png', '//host/file.png', 'data:application/json,{}', 'a\\b.png', '/file.png', '%252e%252e/file.png']) assert.throws(() => resourcePath(DEFAULT_MODEL, path))
})

test('Live2D manifest requires exported moc3/PNG files and validates optional physics', () => {
  const value = { Version: 3, FileReferences: { Moc: 'Haru.moc3', Textures: ['Haru.2048/texture_00.png'], Physics: 'Haru.physics3.json' } }
  const parsed = parseManifest(DEFAULT_MODEL, value)
  assert.equal(parsed.moc, '/live2d/local/models/Haru/Haru.moc3')
  assert.equal(parsed.textures.length, 1); assert.equal(parsed.physics, '/live2d/local/models/Haru/Haru.physics3.json')
  for (const invalid of [null, {}, { Version: 2, FileReferences: value.FileReferences }, { ...value, FileReferences: { ...value.FileReferences, Textures: [] } }, { ...value, FileReferences: { ...value.FileReferences, Moc: 'original.cmo3' } }, { ...value, FileReferences: { ...value.FileReferences, Physics: '../physics.json' } }]) assert.throws(() => parseManifest(DEFAULT_MODEL, invalid))
})

test('Vite HTML fallback is not treated as an installed SDK or model', async () => {
  const request: typeof fetch = async () => new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } })
  const result = await inspectInstallation(DEFAULT_MODEL, new AbortController().signal, request)
  assert.equal(result.length, 3); assert.ok(result.every(check => !check.ready))
  assert.match(result[0]!.problem, /尚未安裝/)
})

test('pose references preserve part visibility settings and reject invalid or escaping files', () => {
  const value = { Version: 3, FileReferences: { Moc: 'Haru.moc3', Textures: ['texture.png'], Pose: 'Haru.pose3.json' } }
  assert.equal(parseManifest(DEFAULT_MODEL, value).pose, '/live2d/local/models/Haru/Haru.pose3.json')
  for (const Pose of ['../Haru.pose3.json', 'settings.json', 'https://host/Haru.pose3.json', 42]) {
    assert.throws(() => parseManifest(DEFAULT_MODEL, { ...value, FileReferences: { ...value.FileReferences, Pose } }))
  }
})

test('installation reports missing Core separately from valid runtime and model files', async () => {
  const request: typeof fetch = async url => url === CORE_URL ? new Response('missing', { status: 404 }) : url === RUNTIME_URL ? new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } }) : Response.json({ Version: 3, FileReferences: { Moc: 'Haru.moc3', Textures: ['texture.png'] } })
  const result = await inspectInstallation(DEFAULT_MODEL, new AbortController().signal, request)
  assert.deepEqual(result.map(check => check.ready), [false, true, true])
})

test('aborted installation checks do not produce misleading missing-file results', async () => {
  const abort = new AbortController(); abort.abort()
  const request: typeof fetch = async (_url, options) => { options!.signal!.throwIfAborted(); return new Response() }
  await assert.rejects(inspectInstallation(DEFAULT_MODEL, abort.signal, request), { name: 'AbortError' })
})

test('late model loads are released and cannot replace the newer actor', async () => {
  const slot = createActorSlot(); let staleRelease = 0, activeRelease = 0
  let resolveOld!: (actor: LiveActor) => void
  const old = slot.load(() => new Promise<LiveActor>(resolve => { resolveOld = resolve }))
  const current: LiveActor = { frame() {}, resize() {}, release() { activeRelease++ } }
  assert.equal(await slot.load(async () => current), current)
  resolveOld({ frame() {}, resize() {}, release() { staleRelease++ } })
  assert.equal(await old, null); assert.equal(staleRelease, 1); assert.equal(activeRelease, 0)
  slot.clear(); slot.clear(); assert.equal(activeRelease, 1)
})

test('unmount cancels loading and disposes an actor that resolves after cancellation', async () => {
  const slot = createActorSlot(); let observed: AbortSignal | undefined, released = 0
  let finish!: (actor: LiveActor) => void
  const loading = slot.load(signal => { observed = signal; return new Promise(resolve => { finish = resolve }) })
  slot.clear(); assert.equal(observed!.aborted, true)
  finish({ frame() {}, resize() {}, release() { released++ } })
  assert.equal(await loading, null); assert.equal(released, 1)
})

test('SDK preparation explains setup and rejects incomplete directories without downloading', async () => {
  const script = resolve('scripts/prepare-live2d.mjs')
  const run = promisify(execFile)
  const help = await run(process.execPath, [script, '--help'])
  assert.match(help.stdout, /不下載 SDK/)
  await assert.rejects(run(process.execPath, [script, resolve('node_modules')]), (error: unknown) => {
    assert.match((error as { stderr: string }).stderr, /SDK 缺少 Core/)
    return true
  })
})
