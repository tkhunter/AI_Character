import { access, cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceArg = process.argv[2]
const runtimeOnly = process.argv[3] === '--runtime-only'
if (!sourceArg || sourceArg === '--help') {
  console.log('先自行從官方下載並解壓 Cubism SDK for Web，再執行：\nnpm run live2d:prepare -- "C:\\SDK\\CubismSdkForWeb"\n此指令不下載 SDK、不代為同意授權；僅建立本機試演檔案。')
  process.exit(sourceArg === '--help' ? 0 : 1)
}
const source = resolve(sourceArg), destination = join(root, 'public/live2d/local')
async function exists(path) { try { await access(path, constants.F_OK); return true } catch { return false } }
try {
  for (const path of ['Core/live2dcubismcore.js', 'Framework/src/live2dcubismframework.ts', 'Samples/Resources/Haru/Haru.model3.json']) {
    if (!await exists(join(source, path))) throw new Error(`SDK 缺少 ${path}。請傳入官方 SDK 解壓後的根目錄。`)
  }
  if (runtimeOnly) {
    if (!await exists(join(destination, 'INSTALLATION.json'))) throw new Error('請先完成初次安裝，再更新執行器。')
    const installed = JSON.parse(await readFile(join(destination, 'INSTALLATION.json'), 'utf8'))
    if (installed.model !== 'Haru' || installed.localUseOnly !== true || !(await readFile(join(source, 'Core/live2dcubismcore.js'))).equals(await readFile(join(destination, 'core/live2dcubismcore.js')))) throw new Error('SDK Core 與既有安裝不一致，不能只更新執行器。')
  } else if (await exists(destination)) throw new Error('public/live2d/local 已存在；為保護既有模型，此指令不覆寫。更新執行器可加 --runtime-only。')
  const manifest = JSON.parse(await readFile(join(source, 'Samples/Resources/Haru/Haru.model3.json'), 'utf8'))
  if (manifest.Version !== 3 || !manifest.FileReferences?.Moc) throw new Error('Haru 範例不是可執行模型包。')
  const staging = join(root, 'node_modules/.tmp', `live2d-${Date.now()}`)
  await mkdir(staging, { recursive: true })
  // All generated files stay under the staging directory until the build succeeds.
  if (!runtimeOnly) await cp(join(source, 'Core'), join(staging, 'core'), { recursive: true, filter: async path => !(await lstat(path)).isSymbolicLink() })
  if (!runtimeOnly) await cp(join(source, 'Samples/Resources/Haru'), join(staging, 'models/Haru'), { recursive: true, filter: async path => {
    const stat = await lstat(path)
    return !stat.isSymbolicLink() && (stat.isDirectory() || /\.(json|moc3|png|txt|md)$/i.test(path))
  } })
  await build({ configFile: false, publicDir: false, resolve: { alias: { '@framework': join(source, 'Framework/src') } }, build: {
    outDir: join(staging, 'runtime'), emptyOutDir: false, minify: false,
    lib: { entry: join(root, 'live2d/adapter.mjs'), formats: ['es'], fileName: () => 'adapter.js' },
  } })
  if (await exists(join(source, 'Framework/Shaders/WebGL'))) await cp(join(source, 'Framework/Shaders/WebGL'), join(staging, 'runtime/shaders'), { recursive: true })
  if (runtimeOnly) {
    if (await exists(join(staging, 'runtime/shaders'))) await cp(join(staging, 'runtime/shaders'), join(destination, 'runtime/shaders'), { recursive: true })
    await rename(join(staging, 'runtime/adapter.js'), join(destination, 'runtime/adapter.js'))
    console.log('本機 Live2D 執行器已更新；Core 與模型包保留。請重新整理瀏覽器；preview 請重新 npm run build。')
    process.exit(0)
  }
  for (const name of ['LICENSE.md', 'NOTICE.md', 'LICENSE', 'NOTICE']) {
    if (await exists(join(source, name))) await cp(join(source, name), join(staging, name))
    if (await exists(join(source, 'Framework', name))) await cp(join(source, 'Framework', name), join(staging, `Framework-${name}`))
  }
  await writeFile(join(staging, 'INSTALLATION.json'), JSON.stringify({ preparedAt: new Date().toISOString(), model: 'Haru', localUseOnly: true }, null, 2))
  await mkdir(dirname(destination), { recursive: true })
  await rename(staging, destination)
  console.log('本機 SDK 與 Haru 已準備：public/live2d/local\n若前端已啟動，開啟「Live2D 試演」重新檢查；正式 preview 請重新 npm run build。')
} catch (error) { console.error(error.message); process.exitCode = 1 }
