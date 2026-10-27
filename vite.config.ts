import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const api = `http://127.0.0.1:${env.API_PORT || process.env.API_PORT || 3001}`
  return {
  plugins: [vue()],
  server: { host: '127.0.0.1', proxy: { '/api': { target: api, timeout: 0, proxyTimeout: 0 } } },
  preview: { host: '127.0.0.1', proxy: { '/api': { target: api, timeout: 0, proxyTimeout: 0 } } },
  }
})
