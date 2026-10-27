import { createApp } from './app.ts'
import { LlamaClient } from './llama.ts'
import { WorkspaceStore } from './storage.ts'

try { process.loadEnvFile('.env') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const baseUrl = process.env.LLAMA_BASE_URL || 'http://127.0.0.1:8080'
const port = Number(process.env.API_PORT || 3001)
const contextLimit = Number(process.env.CONTEXT_LIMIT || 8192)
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(contextLimit) || contextLimit < 512) throw new Error('API_PORT 或 CONTEXT_LIMIT 設定無效。')
// Web search through a local MCP server (e.g. @brave/brave-search-mcp-server); MCP_SEARCH_URL=off disables it.
const searchUrl = process.env.MCP_SEARCH_URL ?? 'http://127.0.0.1:8081/mcp'
const store = new WorkspaceStore(process.env.DATABASE_PATH || 'data/shiori.sqlite')
const app = createApp(new LlamaClient(baseUrl, contextLimit), store, { ttsUrl: process.env.TTS_URL || undefined, searchUrl: searchUrl === 'off' ? undefined : searchUrl })
app.on('error', error => { console.error(`無法啟動本機後端：${error.message}`); process.exit(1) })
app.listen(port, '127.0.0.1', () => console.log(`Shiori API: http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { app.close(); app.closeAllConnections(); store.close(); process.exit(0) })
