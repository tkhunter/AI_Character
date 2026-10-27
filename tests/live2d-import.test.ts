import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { ZipError, extractEntry, readZipEntries, writeZip } from '../server/zip.ts'
import { safeName, stageZip } from '../server/live2dImport.ts'
import { WorkspaceStore, StoreError } from '../server/storage.ts'
import { createApp } from '../server/app.ts'
import { LlamaClient } from '../server/llama.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const MOC = Buffer.concat([Buffer.from('MOC3'), Buffer.alloc(64)])
const manifest = (extra: object = {}) => JSON.stringify({ Version: 3, FileReferences: { Moc: 'natori.moc3', Textures: ['natori.2048/texture_00.png'], Physics: 'natori.physics3.json', Expressions: [{ Name: 'Smile', File: 'exp/Smile.exp3.json' }, { Name: 'Sad', File: 'exp/Sad.exp3.json' }], Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] }, ...extra } })
/** A realistic package nested in a top folder, like the official sample downloads. */
const goodFiles = () => [
  { name: 'Natori/runtime/natori.model3.json', data: manifest(), deflate: true },
  { name: 'Natori/runtime/natori.moc3', data: MOC },
  { name: 'Natori/runtime/natori.2048/texture_00.png', data: PNG },
  { name: 'Natori/runtime/natori.physics3.json', data: '{"Version":3}', deflate: true },
  { name: 'Natori/runtime/exp/Smile.exp3.json', data: '{"Type":"Live2D Expression"}' },
  { name: 'Natori/runtime/motions/idle.motion3.json', data: '{"Version":3}' },
  { name: 'Natori/natori.cmo3', data: 'editor source' },
  { name: '__MACOSX/._natori.moc3', data: 'junk' },
]
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'shiori-import-')); return { dir, cleanup: () => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }) } } }

test('the ZIP reader round-trips stored and deflated files and detects corruption', () => {
  const zip = writeZip([{ name: '中文/檔案.json', data: '{"a":1}' }, { name: 'big.txt', data: 'x'.repeat(5000), deflate: true }])
  const entries = readZipEntries(zip, 10)
  assert.deepEqual(entries.map(e => e.name), ['中文/檔案.json', 'big.txt'])
  assert.equal(extractEntry(zip, entries[1]!).toString(), 'x'.repeat(5000))
  const corrupt = Buffer.from(zip), big = entries[1]!
  corrupt[big.offset + 30 + Buffer.byteLength(big.name) + 2] ^= 0xff // inside the deflated data
  assert.throws(() => extractEntry(corrupt, big), ZipError)
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all'), 10), /不是有效的 ZIP/)
  assert.throws(() => readZipEntries(zip, 1), /檔案太多/)
  assert.equal(safeName('a\\b/c.png'), 'a/b/c.png'); assert.equal(safeName('./a.png'), 'a.png')
  for (const bad of ['../x.png', 'a/../../x.png', '/etc/x.png', 'C:/x.png', 'a//b.png', 'a/./b.png', 'a\u0001.png']) assert.equal(safeName(bad), null, bad)
})

test('staging reports models, missing optional files and skipped files, writing only inside the staging folder', () => {
  const t = temp()
  try {
    const report = stageZip(writeZip(goodFiles()), join(t.dir, 'stage'), 'token')
    assert.equal(report.candidates.length, 1)
    const c = report.candidates[0]!
    assert.equal(c.path, 'Natori/runtime/natori.model3.json'); assert.ok(c.ok, c.problems.join())
    assert.deepEqual(c.expressions, ['Smile', 'Sad']); assert.deepEqual(c.motions, { Idle: 1 }); assert.equal(c.textures, 1)
    assert.deepEqual(c.missing, ['Natori/runtime/exp/Sad.exp3.json'], 'missing optional files are listed, not fatal')
    assert.deepEqual(report.skipped, ['Natori/natori.cmo3'], 'editor files are skipped; macOS junk is ignored silently')
    assert.ok(existsSync(join(t.dir, 'stage', 'Natori/runtime/natori.moc3')))
    assert.ok(!existsSync(join(t.dir, 'stage', '__MACOSX')))
    const broken = stageZip(writeZip(goodFiles().filter(f => !f.name.endsWith('.moc3'))), join(t.dir, 'broken'), 't2')
    assert.equal(broken.candidates[0]!.ok, false); assert.match(broken.candidates[0]!.problems[0]!, /缺少必要檔案：Natori\/runtime\/natori\.moc3/)
  } finally { t.cleanup() }
})

test('malicious or malformed packages are rejected before anything is installed', () => {
  const t = temp()
  const cases: [string, { name: string; data: Buffer | string; deflate?: boolean; mode?: number }[], RegExp][] = [
    ['path traversal', [...goodFiles(), { name: '../../evil.json', data: '{}' }], /不安全的路徑/],
    ['backslash traversal', [...goodFiles(), { name: '..\\evil.json', data: '{}' }], /不安全的路徑/],
    ['absolute path', [...goodFiles(), { name: 'C:/Windows/evil.json', data: '{}' }], /不安全的路徑/],
    ['symlink', [...goodFiles(), { name: 'Natori/link.json', data: '/etc/passwd', mode: 0o120777 }], /符號連結/],
    ['script', [...goodFiles(), { name: 'Natori/runtime/hack.js', data: 'alert(1)' }], /程式或網頁檔/],
    ['html', [...goodFiles(), { name: 'Natori/index.html', data: '<script>' }], /程式或網頁檔/],
    ['svg', [...goodFiles(), { name: 'Natori/icon.svg', data: '<svg onload=x>' }], /程式或網頁檔/],
    ['fake png', goodFiles().map(f => f.name.endsWith('.png') ? { ...f, data: '<html>' } : f), /不是/],
    ['fake moc3', goodFiles().map(f => f.name.endsWith('.moc3') ? { ...f, data: 'nope' } : f), /moc3/],
    ['bad json', [...goodFiles(), { name: 'Natori/runtime/broken.json', data: '{oops' }], /JSON 格式錯誤/],
    ['duplicate names', [...goodFiles(), { name: 'natori/RUNTIME/natori.moc3', data: MOC }], /重複/],
    ['zip bomb', [...goodFiles(), { name: 'Natori/runtime/pad.txt', data: Buffer.alloc(4 * 1024 * 1024), deflate: true }], /壓縮炸彈/],
    ['no model', [{ name: 'readme.txt', data: 'hi' }], /找不到 model3\.json/],
  ]
  try {
    for (const [label, files, message] of cases) {
      const dir = join(t.dir, label.replace(/\s/g, '-'))
      assert.throws(() => stageZip(writeZip(files), dir, label), message, label)
    }
  } finally { t.cleanup() }
})

test('installing moves the package into the models folder and its dist mirror, registers it, and never overwrites', () => {
  const t = temp()
  const models = join(t.dir, 'public/live2d/local/models'), mirror = join(t.dir, 'dist/live2d/local/models')
  mkdirSync(models, { recursive: true }); mkdirSync(join(t.dir, 'dist/live2d/local'), { recursive: true })
  const store = new WorkspaceStore(':memory:', { live2dDir: models, stagingDir: join(t.dir, 'staging'), live2dMirrors: [mirror] })
  try {
    const first = store.importZip(writeZip(goodFiles()))
    assert.throws(() => store.commitImport(first.token, 'nope.model3.json', 'Natori'), /選擇/)
    assert.throws(() => store.commitImport(first.token, first.candidates[0]!.path, ''), /模型名稱/)
    const model = store.commitImport(first.token, first.candidates[0]!.path, 'Natori 官方範例')
    assert.equal(model.available, true, model.problem)
    assert.equal(model.entry, '/live2d/local/models/natori/Natori/runtime/natori.model3.json')
    assert.ok(existsSync(join(models, 'natori', 'Natori/runtime/natori.moc3')))
    assert.ok(existsSync(join(mirror, 'natori', 'Natori/runtime/natori.moc3')), 'vite preview can serve it without a rebuild')
    assert.deepEqual(readdirSync(join(t.dir, 'staging')), [], 'staging is emptied')
    assert.throws(() => store.commitImport(first.token, first.candidates[0]!.path, 'again'), (e: unknown) => e instanceof StoreError && e.status === 404)
    const second = store.importZip(writeZip(goodFiles()))
    const again = store.commitImport(second.token, second.candidates[0]!.path, 'Natori 官方範例')
    assert.match(again.entry, /\/models\/natori-2\//, 'a second import gets its own folder')
    assert.equal(readFileSync(join(models, 'natori', 'Natori/runtime/natori.moc3')).toString('latin1', 0, 4), 'MOC3')
    const third = store.importZip(writeZip(goodFiles())); store.discardImport(third.token)
    assert.throws(() => store.discardImport(third.token), /過期/)
    const broken = store.importZip(writeZip(goodFiles().filter(f => !f.name.endsWith('.png'))))
    assert.throws(() => store.commitImport(broken.token, broken.candidates[0]!.path, 'x'), /無法安裝/)
  } finally { store.close(); t.cleanup() }
})

test('import API: upload, commit, then the model appears in the index', async () => {
  const t = temp()
  const models = join(t.dir, 'models'); mkdirSync(models, { recursive: true })
  const store = new WorkspaceStore(':memory:', { live2dDir: models, stagingDir: join(t.dir, 'staging'), live2dMirrors: [] })
  const app = createApp(new LlamaClient('http://127.0.0.1:9'), store)
  app.listen(0, '127.0.0.1'); await once(app, 'listening')
  const address = app.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`
  try {
    assert.equal((await fetch(`${base}/api/live2d/import`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415)
    const bad = await fetch(`${base}/api/live2d/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: writeZip([...goodFiles(), { name: 'x.js', data: '1' }]) })
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /程式或網頁檔/)
    const uploaded = await fetch(`${base}/api/live2d/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: writeZip(goodFiles()) })
    assert.equal(uploaded.status, 201)
    const report = await uploaded.json()
    const committed = await fetch(`${base}/api/live2d/import/${report.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: report.candidates[0].path, name: 'Natori' }) })
    assert.equal(committed.status, 201)
    const { models: listed } = await (await fetch(`${base}/api/live2d/models`)).json()
    assert.ok(listed.some((m: { name: string; available: boolean }) => m.name === 'Natori' && m.available))
  } finally { app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); store.close(); t.cleanup() }
})
