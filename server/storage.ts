import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { ImportError, installStaged, stageZip, sweepStaging } from './live2dImport.ts'
import type { ImportReport } from './live2dImport.ts'
import { DEFAULT_MODEL, modelPath, parseManifest } from '../src/live2d/model.ts'
import type { Live2DModel } from '../shared/live2d.ts'
import { assertWorkspace } from '../shared/workspace.ts'
import { defaultVoicePreferences } from '../shared/workspace.ts'
import type { Workspace, WorkspaceEnvelope } from '../shared/workspace.ts'
import { ASSET_MAX_BYTES, DEFAULT_CHARACTER_ID, characterAssets, defaultCharacter, normalizeCharacter, sniffImage } from '../shared/characters.ts'
import type { Asset, AssetKind, Character } from '../shared/characters.ts'
import type { Conversation, Message, Saved, ViewState } from '../src/chat/model.ts'

export class StorageConflict extends Error { constructor() { super('其他視窗已更新資料。為避免覆寫，請重新載入已保存版本。') } }
export class StoreError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status } }
const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

export class WorkspaceStore {
  db: DatabaseSync
  assetDir: string | null
  live2dDir: string
  /** Where uploaded model ZIPs are unpacked before the user confirms them. */
  stagingDir: string | null
  /** Extra copies of installed models, e.g. dist/ served by `vite preview`, so imports work without a rebuild. */
  live2dMirrors: string[]
  constructor(path: string, options: { assetDir?: string; live2dDir?: string; stagingDir?: string; live2dMirrors?: string[] } = {}) {
    this.live2dDir = resolve(options.live2dDir ?? 'public/live2d/local/models')
    this.stagingDir = options.stagingDir ?? (path === ':memory:' ? null : join(dirname(resolve(path)), 'live2d-staging'))
    this.live2dMirrors = options.live2dMirrors ?? (options.live2dDir ? [] : [resolve('dist/live2d/local/models')])
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
    this.assetDir = options.assetDir ?? (path === ':memory:' ? null : join(dirname(resolve(path)), 'assets'))
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number
    if (version > 4) { this.db.close(); throw new Error('資料庫版本較新，請使用相容的應用程式。') }
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE workspace_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, write_id TEXT, active_id TEXT, preferences TEXT, panel_policy TEXT, updated_at TEXT);
      INSERT INTO workspace_meta (id, revision) VALUES (1, 0);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, position INTEGER NOT NULL, title TEXT NOT NULL, time TEXT NOT NULL, view_json TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, position INTEGER NOT NULL, payload_json TEXT NOT NULL);
      CREATE INDEX messages_conversation ON messages(conversation_id, position);
      CREATE TABLE favorites (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), position INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
      PRAGMA user_version = 1;
      COMMIT;
    `)
    if (version <= 1) {
      // v2: characters and local image assets. Existing conversations belong to the original character.
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`
          CREATE TABLE assets (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('portrait','background')), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, file_name TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE characters (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload_json TEXT NOT NULL, portrait_asset_id TEXT REFERENCES assets(id), background_asset_id TEXT REFERENCES assets(id));
          ALTER TABLE conversations ADD COLUMN character_id TEXT NOT NULL DEFAULT '${DEFAULT_CHARACTER_ID}';
        `)
        this.db.prepare('INSERT INTO characters VALUES (?, 0, ?, NULL, NULL)').run(DEFAULT_CHARACTER_ID, JSON.stringify(defaultCharacter()))
        this.db.exec('PRAGMA user_version = 2; COMMIT;')
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
    if (version <= 2) {
      // v3: expressions, voice and memories live in the character payload; scenes and the memory cursor per conversation.
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`
          ALTER TABLE conversations ADD COLUMN background_asset_id TEXT REFERENCES assets(id);
          ALTER TABLE conversations ADD COLUMN scene_label TEXT NOT NULL DEFAULT '';
          ALTER TABLE conversations ADD COLUMN memory_cursor INTEGER NOT NULL DEFAULT 0;
        `)
        const update = this.db.prepare('UPDATE characters SET payload_json=? WHERE id=?')
        for (const row of this.db.prepare('SELECT id, payload_json FROM characters').all()) update.run(JSON.stringify(normalizeCharacter(JSON.parse(row.payload_json as string))), row.id as string)
        const meta = this.db.prepare('SELECT preferences FROM workspace_meta WHERE id=1').get()
        if (meta?.preferences) this.db.prepare('UPDATE workspace_meta SET preferences=? WHERE id=1').run(JSON.stringify({ ...defaultVoicePreferences(), ...JSON.parse(meta.preferences as string) }))
        this.db.exec('PRAGMA user_version = 3; COMMIT;')
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
    if (version <= 3) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec('CREATE TABLE live2d_models (id TEXT PRIMARY KEY, name TEXT NOT NULL, entry TEXT NOT NULL UNIQUE)')
        this.db.prepare('INSERT INTO live2d_models VALUES (?,?,?)').run('haru', 'Haru · 官方範例', DEFAULT_MODEL)
        const update = this.db.prepare('UPDATE characters SET payload_json=? WHERE id=?')
        for (const row of this.db.prepare('SELECT id,payload_json FROM characters').all()) update.run(JSON.stringify(normalizeCharacter(JSON.parse(row.payload_json as string))), row.id as string)
        // Invalidate stale clients so a pre-migration form cannot erase the new settings.
        this.db.exec('UPDATE workspace_meta SET revision=revision+1,write_id=NULL WHERE revision>0; PRAGMA user_version=4; COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
  }
  read(): WorkspaceEnvelope {
    const meta = this.db.prepare('SELECT * FROM workspace_meta WHERE id=1').get()!
    if (meta.revision === 0) return { revision: 0, snapshot: null }
    // A read transaction keeps the complete graph at one revision across multiple connections.
    this.db.exec('BEGIN')
    try {
      const current = this.db.prepare('SELECT * FROM workspace_meta WHERE id=1').get()!
      const characters = this.db.prepare('SELECT payload_json FROM characters ORDER BY position').all().map(c => JSON.parse(c.payload_json as string) as Character)
      const conversations: Conversation[] = (this.db.prepare('SELECT * FROM conversations ORDER BY position').all()).map(c => ({
        id: c.id as string, characterId: c.character_id as string, backgroundAssetId: (c.background_asset_id as string | null) ?? null, sceneLabel: c.scene_label as string, memoryCursor: c.memory_cursor as number, title: c.title as string, time: c.time as string, view: JSON.parse(c.view_json as string) as ViewState,
        messages: this.db.prepare('SELECT payload_json FROM messages WHERE conversation_id=? ORDER BY position').all(c.id!).map(m => JSON.parse(m.payload_json as string) as Message),
      }))
      const saved = this.db.prepare('SELECT * FROM favorites ORDER BY position').all().map(s => ({ id: s.id as string, conversationId: s.conversation_id as string, message: JSON.parse(s.snapshot_json as string) as Message })) as Saved[]
      const snapshot: Workspace = { schemaVersion: 3, activeId: current.active_id as string, characters, conversations, saved, preferences: JSON.parse(current.preferences as string), panelPolicy: JSON.parse(current.panel_policy as string) }
      assertWorkspace(snapshot)
      this.db.exec('COMMIT')
      return { revision: current.revision as number, snapshot }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  save(baseRevision: number, writeId: string, snapshot: Workspace) {
    assertWorkspace(snapshot)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const meta = this.db.prepare('SELECT revision, write_id FROM workspace_meta WHERE id=1').get()!
      // Retrying an acknowledged-lost request is idempotent, not a stale overwrite.
      if (meta.write_id === writeId) { this.db.exec('COMMIT'); return meta.revision as number }
      if (meta.revision !== baseRevision) throw new StorageConflict()
      const assetKind = this.db.prepare('SELECT kind FROM assets WHERE id=?')
      for (const c of snapshot.characters) if (c.presentation.modelId !== null && !this.db.prepare('SELECT id FROM live2d_models WHERE id=?').get(c.presentation.modelId)) throw new StoreError('角色使用的 Live2D 模型索引已不存在，請重新選擇。')
      for (const c of snapshot.characters) for (const [assetId, kind] of characterAssets(c)) {
        if (assetKind.get(assetId)?.kind !== kind) throw new StoreError('角色使用的素材已不存在或類型不符，請重新選擇素材。')
      }
      for (const c of snapshot.conversations) if (c.backgroundAssetId !== null && assetKind.get(c.backgroundAssetId)?.kind !== 'background') throw new StoreError('對話場景使用的背景已不存在，請重新選擇。')
      this.db.exec('DELETE FROM characters')
      const insertCharacter = this.db.prepare('INSERT INTO characters VALUES(?,?,?,?,?)')
      snapshot.characters.forEach((c, index) => insertCharacter.run(c.id, index, JSON.stringify(c), c.portraitAssetId, c.backgroundAssetId))
      const upsertConversation = this.db.prepare(`INSERT INTO conversations (id, position, title, time, view_json, character_id, background_asset_id, scene_label, memory_cursor) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,title=excluded.title,time=excluded.time,view_json=excluded.view_json,character_id=excluded.character_id,background_asset_id=excluded.background_asset_id,scene_label=excluded.scene_label,memory_cursor=excluded.memory_cursor WHERE conversations.position!=excluded.position OR conversations.title!=excluded.title OR conversations.time!=excluded.time OR conversations.view_json!=excluded.view_json OR conversations.character_id!=excluded.character_id OR conversations.background_asset_id IS NOT excluded.background_asset_id OR conversations.scene_label!=excluded.scene_label OR conversations.memory_cursor!=excluded.memory_cursor`)
      const upsertMessage = this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,position=excluded.position,payload_json=excluded.payload_json WHERE messages.conversation_id!=excluded.conversation_id OR messages.position!=excluded.position OR messages.payload_json!=excluded.payload_json`)
      // Temporary key sets make removals safe without an SQL placeholder limit.
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS retained_conversations (id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS retained_messages (id TEXT PRIMARY KEY); DELETE FROM retained_conversations; DELETE FROM retained_messages; DELETE FROM favorites;')
      const keepConversation = this.db.prepare('INSERT INTO retained_conversations VALUES (?)'), keepMessage = this.db.prepare('INSERT INTO retained_messages VALUES (?)')
      snapshot.conversations.forEach((c, index) => {
        keepConversation.run(c.id); upsertConversation.run(c.id, index, c.title, c.time, JSON.stringify(c.view), c.characterId, c.backgroundAssetId, c.sceneLabel, c.memoryCursor)
        c.messages.forEach((m, position) => { keepMessage.run(m.id); upsertMessage.run(m.id, c.id, position, JSON.stringify(m)) })
      })
      this.db.exec('DELETE FROM messages WHERE id NOT IN (SELECT id FROM retained_messages); DELETE FROM conversations WHERE id NOT IN (SELECT id FROM retained_conversations);')
      const insertSaved = this.db.prepare('INSERT INTO favorites VALUES(?,?,?,?,?)')
      snapshot.saved.forEach((s, index) => insertSaved.run(s.id, s.conversationId, s.message.id, index, JSON.stringify(s.message)))
      const revision = baseRevision + 1
      this.db.prepare('UPDATE workspace_meta SET revision=?, write_id=?, active_id=?, preferences=?, panel_policy=?, updated_at=? WHERE id=1').run(revision, writeId, snapshot.activeId, JSON.stringify(snapshot.preferences), JSON.stringify(snapshot.panelPolicy), new Date().toISOString())
      this.db.exec('COMMIT')
      return revision
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** The prompt comes from the durable record, never from the browser request. */
  character(id: string): Character | null {
    const row = this.db.prepare('SELECT payload_json FROM characters WHERE id=?').get(id)
    return row ? JSON.parse(row.payload_json as string) as Character : null
  }
  listAssets(): Asset[] {
    return this.db.prepare('SELECT id, kind, name, mime, size, created_at FROM assets ORDER BY created_at, id').all().map(a => ({ id: a.id as string, kind: a.kind as AssetKind, name: a.name as string, mime: a.mime as string, size: a.size as number, createdAt: a.created_at as string }))
  }
  addAsset(kind: string, name: string, bytes: Uint8Array): Asset {
    if (!this.assetDir) throw new StoreError('此服務未啟用素材保存。', 503)
    if (kind !== 'portrait' && kind !== 'background') throw new StoreError('素材類型必須是立繪或背景。')
    if (!bytes.length) throw new StoreError('素材檔案是空的。')
    if (bytes.length > ASSET_MAX_BYTES) throw new StoreError('素材檔案太大（上限 8 MB）。', 413)
    const mime = sniffImage(bytes)
    if (!mime) throw new StoreError('只支援 PNG、JPEG、WebP 或 GIF 圖片。', 415)
    const label = [...name.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, 100).join('') || '未命名素材'
    const asset: Asset = { id: crypto.randomUUID(), kind, name: label, mime, size: bytes.length, createdAt: new Date().toISOString() }
    const fileName = asset.id + extensions[mime]
    mkdirSync(this.assetDir, { recursive: true })
    const target = join(this.assetDir, fileName), temporary = `${target}.partial`
    // Write the file first so a committed row never points at a missing image.
    writeFileSync(temporary, bytes); renameSync(temporary, target)
    try { this.db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(asset.id, kind, asset.name, mime, asset.size, fileName, asset.createdAt) }
    catch (error) { try { unlinkSync(target) } catch { /* Already gone. */ } throw error }
    return asset
  }
  assetFile(id: string) {
    if (!this.assetDir) return null
    const row = this.db.prepare('SELECT mime, file_name FROM assets WHERE id=?').get(id)
    if (!row) return null
    try { return { mime: row.mime as string, bytes: readFileSync(join(this.assetDir, row.file_name as string)) } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  deleteAsset(id: string) {
    const row = this.db.prepare('SELECT file_name FROM assets WHERE id=?').get(id)
    if (!row) throw new StoreError('找不到此素材。', 404)
    const users = this.db.prepare('SELECT payload_json FROM characters').all().map(c => JSON.parse(c.payload_json as string) as Character).filter(c => characterAssets(c).some(([asset]) => asset === id)).map(c => c.name)
    if (users.length) throw new StoreError(`素材正被「${users.join('」、「')}」使用，請先更換角色素材。`, 409)
    const scenes = this.db.prepare('SELECT title FROM conversations WHERE background_asset_id=?').all(id).map(c => c.title as string)
    if (scenes.length) throw new StoreError(`素材是對話「${scenes.join('」、「')}」的場景，請先更換場景。`, 409)
    this.db.prepare('DELETE FROM assets WHERE id=?').run(id)
    if (this.assetDir) try { unlinkSync(join(this.assetDir, row.file_name as string)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  /** Check real paths as well as manifest references; model packages cannot escape the local root via symlinks. */
  checkModel(entry: string) {
    const path = modelPath(entry)
    const root = realpathSync(this.live2dDir)
    const file = (url: string) => {
      const relative = decodeURIComponent(url.slice('/live2d/local/models/'.length))
      const resolved = realpathSync(resolve(root, relative))
      if (!resolved.startsWith(root + sep) || !statSync(resolved).isFile()) throw new StoreError('模型素材必須位於本機模型目錄內。')
      return resolved
    }
    const manifestFile = file(path)
    if (statSync(manifestFile).size > 1024 * 1024) throw new StoreError('模型入口太大。')
    const manifest = parseManifest(path, JSON.parse(readFileSync(manifestFile, 'utf8')))
    const packageRoot = realpathSync(dirname(manifestFile)) + sep
    for (const url of [manifest.moc, ...manifest.textures, manifest.physics, manifest.pose]) if (url && !file(url).startsWith(packageRoot)) throw new StoreError('模型素材不可離開模型包目錄。')
  }
  listModels(): Live2DModel[] {
    return this.db.prepare('SELECT id,name,entry FROM live2d_models ORDER BY name,id').all().map(row => {
      const model = { id: row.id as string, name: row.name as string, entry: row.entry as string }
      try { this.checkModel(model.entry); return { ...model, available: true, problem: '' } }
      catch { return { ...model, available: false, problem: '模型包缺檔或引用無效，載入時將使用靜態立繪。' } }
    })
  }
  addModel(name: unknown, entry: unknown) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof entry !== 'string' || entry.length > 1000) throw new StoreError('請填寫模型名稱與本機 model3.json 路徑。')
    try { this.checkModel(entry) } catch { throw new StoreError('模型包缺檔或路徑不正確，請確認本機 model3.json 與引用素材完整。') }
    if (this.db.prepare('SELECT id FROM live2d_models WHERE entry=?').get(entry)) throw new StoreError('此模型已加入索引。', 409)
    if ((this.db.prepare('SELECT COUNT(*) AS total FROM live2d_models').get()!.total as number) >= 100) throw new StoreError('模型索引最多 100 個。')
    const id = crypto.randomUUID()
    this.db.prepare('INSERT INTO live2d_models VALUES (?,?,?)').run(id, name.trim(), entry)
    return this.listModels().find(model => model.id === id)!
  }
  deleteModel(id: string) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const users = this.db.prepare('SELECT payload_json FROM characters').all().map(row => JSON.parse(row.payload_json as string) as Character).filter(c => c.presentation.modelId === id)
      if (users.length) throw new StoreError(`模型正被「${users.map(c => c.name).join('」、「')}」引用，請先解除綁定並保存。`, 409)
      if (!this.db.prepare('DELETE FROM live2d_models WHERE id=?').run(id).changes) throw new StoreError('找不到模型索引。', 404)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  importZip(zip: Buffer): ImportReport {
    if (!this.stagingDir) throw new StoreError('此服務未啟用模型匯入。', 503)
    sweepStaging(this.stagingDir)
    const token = crypto.randomUUID(), dir = join(this.stagingDir, token)
    try { return stageZip(zip, dir, token) }
    catch (error) { rmSync(dir, { recursive: true, force: true }); throw error instanceof ImportError ? new StoreError(error.message, error.status) : error }
  }
  private staged(token: string) {
    if (!this.stagingDir || !/^[0-9a-f-]{36}$/.test(token)) throw new StoreError('找不到這次匯入，請重新上傳。', 404)
    const dir = join(this.stagingDir, token), file = join(dir, '.import.json')
    if (!existsSync(file)) throw new StoreError('這次匯入已過期，請重新上傳。', 404)
    return { dir, report: JSON.parse(readFileSync(file, 'utf8')) as ImportReport }
  }
  /** Install one model from a staged import and add it to the index; any failure removes the copied files. */
  commitImport(token: string, path: unknown, name: unknown) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new StoreError('請填寫 1 到 100 字的模型名稱。')
    const { dir, report } = this.staged(token)
    const candidate = report.candidates.find(c => c.path === path)
    if (!candidate) throw new StoreError('請選擇壓縮檔中的一個模型。')
    if (!candidate.ok) throw new StoreError(`這個模型無法安裝：${candidate.problems.join('；')}`)
    // The folder is named after the model file (stable, URL-friendly); the display name stays editable in the index.
    const installed = installStaged(dir, this.live2dDir, this.live2dMirrors, candidate.name, candidate.path)
    try { return this.addModel(name.trim(), installed.entry) }
    catch (error) {
      rmSync(installed.target, { recursive: true, force: true })
      for (const mirror of this.live2dMirrors) rmSync(join(mirror, installed.folder), { recursive: true, force: true })
      throw error
    }
  }
  discardImport(token: string) { const { dir } = this.staged(token); rmSync(dir, { recursive: true, force: true }) }
  close() { this.db.close() }
}
