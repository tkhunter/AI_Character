import { ref } from 'vue'
import type { Live2DModel } from '../../shared/live2d'
const models = ref<Live2DModel[]>([]), problem = ref(''), loading = ref(false)
let loadTicket = 0
async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, options)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || '無法更新模型索引。')
  return body
}
export function useModelCatalog() {
  async function load() {
    const ticket = ++loadTicket
    loading.value = true; problem.value = ''
    try { const body = await request('/api/live2d/models'); if (ticket === loadTicket) models.value = body.models }
    catch (error) { if (ticket === loadTicket) problem.value = (error as Error).message }
    finally { if (ticket === loadTicket) loading.value = false }
  }
  async function register(name: string, entry: string) {
    problem.value = ''
    try { await request('/api/live2d/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, entry }) }); await load(); return true }
    catch (error) { problem.value = (error as Error).message; return false }
  }
  async function remove(id: string) {
    problem.value = ''
    try { await request(`/api/live2d/models/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load() }
    catch (error) { problem.value = (error as Error).message }
  }
  return { models, problem, loading, load, register, remove }
}
