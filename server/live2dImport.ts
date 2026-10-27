import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { parseManifest } from '../src/live2d/model.ts'
import { ZipError, extractEntry, readZipEntries } from './zip.ts'

export const IMPORT_LIMITS = { zipBytes: 200 * 1024 * 1024, entries: 2000, totalBytes: 600 * 1024 * 1024, fileBytes: 150 * 1024 * 1024, ratio: 250, jsonBytes: 5 * 1024 * 1024 }
/** Executable or active web content is never accepted, even if unused by the model. */
const FORBIDDEN = /\.(m?js|cjs|ts|html?|xhtml|svg|php|exe|dll|bat|cmd|ps1|sh|vbs|wasm|jar|com|scr|msi|lnk|url|hta)$/i
const ALLOWED = /\.(json|moc3|png|wav|mp3|ogg|txt|md)$/i
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i

export class ImportError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status } }
export type ImportCandidate = {
  path: string; name: string; ok: boolean; problems: string[]; missing: string[]
  textures: number; expressions: string[]; motions: Record<string, number>
}
export type ImportReport = { token: string; files: number; bytes: number; skipped: string[]; candidates: ImportCandidate[]; createdAt: number }

/** A safe relative path inside the package, or null for names that must not be extracted. */
export function safeName(raw: string) {
  const name = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\u0000-\u001f]/.test(name)) return null
  const parts = name.split('/')
  if (parts.some(part => part === '..' || part === '.' || part === '')) return null
  return parts.join('/')
}
const isPng = (b: Buffer) => b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG'
const isMoc = (b: Buffer) => b.length >= 4 && b.toString('latin1', 0, 4) === 'MOC3'
const urlOf = (path: string) => '/live2d/local/models/__import__/' + path.split('/').map(encodeURIComponent).join('/')
const pathOf = (url: string) => decodeURIComponent(url.slice('/live2d/local/models/__import__/'.length))

/** Validate a ZIP and extract the allowed files into `dir`; nothing outside `dir` is ever written. */
export function stageZip(zip: Buffer, dir: string, token: string): ImportReport {
  if (zip.length > IMPORT_LIMITS.zipBytes) throw new ImportError('ZIP 檔太大（上限 200 MB）。', 413)
  let entries
  try { entries = readZipEntries(zip, IMPORT_LIMITS.entries) } catch (error) { throw new ImportError(error instanceof ZipError ? error.message : '無法讀取 ZIP 檔。') }
  // Keyed case-insensitively (Windows paths are); keeps the archive's own spelling for extraction.
  const files = new Map<string, { name: string; data: Buffer }>(), skipped: string[] = []
  let total = 0
  for (const entry of entries) {
    if (entry.directory || JUNK.test(entry.name.replace(/\\/g, '/'))) continue
    const name = safeName(entry.name)
    if (!name) throw new ImportError(`壓縮檔含有不安全的路徑：${entry.name}`)
    if (entry.symlink) throw new ImportError(`壓縮檔含有符號連結，已拒絕：${name}`)
    if (FORBIDDEN.test(name)) throw new ImportError(`模型包不可包含程式或網頁檔：${name}`)
    if (!ALLOWED.test(name)) { skipped.push(name); continue }
    if (files.has(name.toLowerCase())) throw new ImportError(`壓縮檔內有重複的檔名：${name}`)
    if (entry.size > IMPORT_LIMITS.fileBytes) throw new ImportError(`單一檔案太大：${name}`, 413)
    total += entry.size
    if (total > IMPORT_LIMITS.totalBytes) throw new ImportError('解壓縮後總大小超過 600 MB。', 413)
    if (entry.size > 1024 * 1024 && entry.size / Math.max(1, entry.compressed) > IMPORT_LIMITS.ratio) throw new ImportError(`壓縮比異常，疑似壓縮炸彈：${name}`)
    let data: Buffer
    try { data = extractEntry(zip, entry) } catch (error) { throw new ImportError(error instanceof ZipError ? error.message : `無法解壓縮：${name}`) }
    if (/\.png$/i.test(name) && !isPng(data)) throw new ImportError(`檔案副檔名是 PNG 但內容不是：${name}`)
    if (/\.moc3$/i.test(name) && !isMoc(data)) throw new ImportError(`不是有效的 moc3 檔：${name}`)
    if (/\.json$/i.test(name)) {
      if (data.length > IMPORT_LIMITS.jsonBytes) throw new ImportError(`JSON 檔太大：${name}`)
      try { JSON.parse(data.toString('utf8').replace(/^﻿/, '')) } catch { throw new ImportError(`JSON 格式錯誤：${name}`) }
    }
    files.set(name.toLowerCase(), { name, data })
  }
  const names = [...files.values()].map(f => f.name)
  const models = names.filter(n => /\.model3\.json$/i.test(n))
  if (!models.length) throw new ImportError('壓縮檔裡找不到 model3.json。請確認是 Cubism 匯出的執行用模型（不是 cmo3／PSD 原始檔）。')
  const has = (path: string) => files.has(path.toLowerCase())
  const candidates: ImportCandidate[] = models.map(path => {
    const problems: string[] = [], missing: string[] = []
    let textures = 0, expressions: string[] = [], motions: Record<string, number> = {}
    try {
      const manifest = parseManifest(urlOf(path), JSON.parse(files.get(path.toLowerCase())!.data.toString('utf8').replace(/^﻿/, '')))
      textures = manifest.textures.length
      expressions = manifest.expressions.map(e => e.name)
      motions = Object.fromEntries(Object.entries(manifest.motions).map(([g, l]) => [g, l.length]))
      for (const url of [manifest.moc, ...manifest.textures]) if (!has(pathOf(url))) problems.push(`缺少必要檔案：${pathOf(url)}`)
      for (const url of [manifest.physics, manifest.pose, ...manifest.expressions.map(e => e.file), ...Object.values(manifest.motions).flat().map(m => m.file)]) if (url && !has(pathOf(url))) missing.push(pathOf(url))
    } catch (error) { problems.push(error instanceof Error ? error.message : '模型入口格式不正確。') }
    return { path, name: posix.basename(path).replace(/\.model3\.json$/i, ''), ok: !problems.length, problems, missing, textures, expressions, motions }
  })
  mkdirSync(dir, { recursive: true })
  const root = resolve(dir) + sep
  let bytes = 0
  for (const name of names) {
    const target = resolve(dir, name)
    if (!target.startsWith(root)) throw new ImportError(`不安全的路徑：${name}`)
    mkdirSync(dirname(target), { recursive: true })
    const data = files.get(name.toLowerCase())!.data
    writeFileSync(target, data); bytes += data.length
  }
  const report: ImportReport = { token, files: names.length, bytes, skipped, candidates, createdAt: Date.now() }
  writeFileSync(join(dir, '.import.json'), JSON.stringify(report))
  return report
}

/** Folder name for an installed package: readable, filesystem- and URL-safe, never overwriting. */
export function packageFolder(root: string, name: string) {
  const base = name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model'
  let folder = base, n = 2
  while (existsSync(join(root, folder))) folder = `${base}-${n++}`
  return folder
}
/** Move a staged package into the models directory (and a mirror such as dist/), returning its entry URL. */
export function installStaged(staging: string, modelsDir: string, mirrors: string[], name: string, path: string) {
  const folder = packageFolder(modelsDir, name), target = join(modelsDir, folder)
  rmSync(join(staging, '.import.json'), { force: true })
  mkdirSync(modelsDir, { recursive: true })
  try { renameSync(staging, target) } catch { cpSync(staging, target, { recursive: true }); rmSync(staging, { recursive: true, force: true }) }
  for (const mirror of mirrors) if (existsSync(dirname(mirror))) { mkdirSync(mirror, { recursive: true }); cpSync(target, join(mirror, folder), { recursive: true }) }
  return { folder, target, entry: `/live2d/local/models/${encodeURIComponent(folder)}/${path.split('/').map(encodeURIComponent).join('/')}` }
}
/** Remove staged imports older than `maxAge`. */
export function sweepStaging(dir: string, maxAge = 60 * 60 * 1000) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try { if (Date.now() - statSync(path).mtimeMs > maxAge) rmSync(path, { recursive: true, force: true }) } catch { /* in use or gone */ }
  }
}
