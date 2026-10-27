import { spawn } from 'node:child_process'
const children = [
  spawn(process.execPath, ['--watch', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', ...process.argv.slice(2)], { stdio: 'inherit' }),
]
let closing = false
function stop(code = 0) { if (closing) return; closing = true; for (const child of children) child.kill(); process.exit(code) }
children.forEach(child => { child.on('exit', code => stop(code ?? 0)); child.on('error', () => stop(1)) })
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop())
