// Compiled only by live2d:prepare against the user's locally downloaded official SDK.
// The SDK's Core/Framework licenses remain applicable to the resulting local bundle.
import { CubismFramework } from '@framework/live2dcubismframework'
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson'
import { CubismUserModel } from '@framework/model/cubismusermodel'
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink'
import { CubismMatrix44 } from '@framework/math/cubismmatrix44'
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl'
import { CubismExpressionMotion } from '@framework/motion/cubismexpressionmotion'
import { CubismMotion } from '@framework/motion/cubismmotion'
import { localFile, modelPath, parseManifest } from '../src/live2d/model.ts'
import { bustOf } from '../shared/live2d.ts'

let actors = 0
export async function createActor(canvas, entry, signal) {
  modelPath(entry)
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true })
  if (!gl) throw new Error('此瀏覽器無法建立 WebGL，請繼續使用靜態立繪。')
  if (!actors) { CubismFramework.startUp(); CubismFramework.initialize() }
  actors++
  const textures = []
  let user
  let disposed = false, time = 0, blink, width = 1, height = 1
  let view = { scale: 1, x: 0, y: 0, gaze: false, framing: 'full' }, shown = null, gazeX = 0, gazeY = 0, targetX = 0, targetY = 0
  const names = new Map()
  function release() {
    if (disposed) return
    disposed = true
    try { user?.release() } finally {
      textures.forEach(texture => gl.deleteTexture(texture))
      actors--
      if (!actors) { CubismRenderer_WebGL.doStaticRelease?.(); CubismFramework.dispose() }
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
  async function bytes(path) { return (await localFile(path, signal)).arrayBuffer() }
  try {
    user = new CubismUserModel()
    const settingBytes = await bytes(entry)
    const manifest = parseManifest(entry, JSON.parse(new TextDecoder().decode(settingBytes)))
    const setting = new CubismModelSettingJson(settingBytes, settingBytes.byteLength)
    const moc = await bytes(manifest.moc)
    user.loadModel(moc, true)
    const model = user.getModel()
    if (!model) throw new Error('模型與目前 Cubism Core 不相容。')
    if (manifest.physics) { const physics = await bytes(manifest.physics); user.loadPhysics(physics, physics.byteLength) }
    if (manifest.pose) { const pose = await bytes(manifest.pose); user.loadPose(pose, pose.byteLength) }
    blink = CubismEyeBlink.create(setting)
    // Expressions and motions come only from the validated manifest; failed files are skipped, not fatal.
    const expressions = new Map(), motions = new Map()
    for (const item of manifest.expressions) {
      try { const data = await bytes(item.file); const motion = CubismExpressionMotion.create(data, data.byteLength); if (motion) expressions.set(item.name, motion) } catch (error) { if (signal.aborted) throw error }
    }
    const effectIds = (count, get) => Array.from({ length: count }, (_, i) => get(i))
    const eyeBlinkIds = effectIds(setting.getEyeBlinkParameterCount(), i => setting.getEyeBlinkParameterId(i))
    const lipSyncIds = effectIds(setting.getLipSyncParameterCount(), i => setting.getLipSyncParameterId(i))
    for (const [group, list] of Object.entries(manifest.motions)) {
      const loaded = []
      for (const item of list) {
        try {
          const data = await bytes(item.file)
          const motion = CubismMotion.create(data, data.byteLength)
          if (!motion) { loaded.push(null); continue }
          if (item.fadeIn !== undefined) motion.setFadeInTime(item.fadeIn)
          if (item.fadeOut !== undefined) motion.setFadeOutTime(item.fadeOut)
          motion.setEffectIds(eyeBlinkIds, lipSyncIds)
          loaded.push(motion)
        } catch (error) { if (signal.aborted) throw error; loaded.push(null) }
      }
      motions.set(group, loaded)
    }
    const motionManager = user._motionManager, expressionManager = user._expressionManager
    let idleGroup = null
    function pickMotion(group, index) {
      const list = motions.get(group)?.map((motion, i) => [motion, i]).filter(([motion]) => motion) ?? []
      if (!list.length) return null
      if (index === null) return list[Math.floor(Math.random() * list.length)][0]
      return list.find(([, i]) => i === index)?.[0] ?? null
    }
    function playMotion(group, index, priority) {
      const motion = pickMotion(group, index)
      if (!motion) return false
      // Equal or higher priority replaces the running motion (a later cue of the same reply wins);
      // lower priority (idle) never interrupts a cue motion. Cubism's reserveMotion rejects equal priority.
      const current = motionManager.isFinished() ? 0 : motionManager.getCurrentPriority()
      if (priority < current) return false
      motionManager.setReservePriority(priority)
      motionManager.startMotionPriority(motion, false, priority)
      return true
    }
    function setIdleMotion(group) { idleGroup = group && motions.has(group) ? group : null }
    function setExpression(name) {
      const motion = name ? expressions.get(name) : null
      if (motion) expressionManager.startMotion(motion, false)
      else expressionManager.stopAllMotions()
    }
    // Lip sync writes the model's LipSync group (ParamMouthOpenY when the model declares none).
    let mouth = 0
    function setMouth(value) { mouth = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0 }
    function capabilities() { return { expressions: [...expressions.keys()], motions: Object.fromEntries([...motions].map(([group, list]) => [group, list.length])) } }
    for (let index = 0; index < model.getParameterCount(); index++) {
      const id = model.getParameterId(index), text = id.getString()
      names.set(typeof text === 'string' ? text : text.s, id)
    }
    user.createRenderer(canvas.width || 1, canvas.height || 1)
    const renderer = user.getRenderer()
    renderer.startUp(gl)
    renderer.setIsPremultipliedAlpha(true)
    // New SDK versions load shader files; older versions embed them and omit this method.
    renderer.loadShaders?.('/live2d/local/runtime/shaders/')
    for (let index = 0; index < manifest.textures.length; index++) {
      const blob = await (await localFile(manifest.textures[index], signal)).blob()
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
      try {
        signal.throwIfAborted()
        if (bitmap.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || bitmap.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('模型貼圖超過此裝置可用的大小。')
        const texture = gl.createTexture()
        if (!texture) throw new Error('無法配置模型貼圖。')
        textures.push(texture)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
        renderer.bindTexture(index, texture)
      } finally { bitmap.close() }
    }
    model.saveParameters()
    const matrix = user.getModelMatrix()
    const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    /** Height and centre of the model in clip space (the viewport is 2 units tall). */
    function framingTarget() {
      const modelRatio = model.getCanvasWidth() / model.getCanvasHeight()
      const full = 1.95 * Math.min(1, width / height / modelRatio) * view.scale
      // Exported model vertices already use a centered coordinate system.
      if (view.framing !== 'bust') return { h: full, px: view.x * width / height, py: view.y }
      // Bust: zoom in and move the focus point (a fraction of the half-height above centre) to the viewport centre.
      const bust = bustOf(view), h = full * bust.zoom
      return { h, px: view.x * width / height, py: view.y - bust.focus * h / 2 }
    }
    function applyFraming(delta) {
      const target = framingTarget()
      if (!shown || delta === null || reducedMotion()) shown = { ...target }
      else { const k = 1 - Math.exp(-delta * 7); for (const key of ['h', 'px', 'py']) shown[key] += (target[key] - shown[key]) * k }
      matrix.setHeight(shown.h); matrix.setPosition(shown.px, shown.py)
    }
    function resize(w, h) {
      width = Math.max(1, w); height = Math.max(1, h)
      // A new canvas size is not a framing change, so it snaps instead of easing.
      applyFraming(null)
      user.setRenderTargetSize?.(width, height)
    }
    function configure(value) {
      const keepEasing = shown !== null
      view = { scale: value.scale, x: value.x, y: value.y, gaze: value.gaze, framing: value.framing ?? 'full', bustZoom: value.bustZoom, bustFocus: value.bustFocus }
      if (!view.gaze) { targetX = 0; targetY = 0 }
      if (!keepEasing) applyFraming(null)
    }
    function look(x, y) { targetX = Math.max(-1, Math.min(1, x)); targetY = Math.max(-1, Math.min(1, y)) }
    function frame(delta) {
      if (disposed || signal.aborted) return
      time += delta
      applyFraming(delta)
      model.loadParameters()
      // Motions write the base pose (as in the official sample); idle loops only when a group is mapped.
      if (motionManager.isFinished()) { if (idleGroup) playMotion(idleGroup, null, 1) }
      else motionManager.updateMotion(model, delta)
      model.saveParameters()
      expressionManager.updateMotion(model, delta)
      blink.updateParameters(model, delta)
      if (mouth > 0) { const ids = lipSyncIds.length ? lipSyncIds : names.has('ParamMouthOpenY') ? [names.get('ParamMouthOpenY')] : []; for (const id of ids) model.addParameterValueById(id, mouth, 0.8) }
      const breath = names.get('ParamBreath'), sway = names.get('ParamAngleZ')
      if (breath) model.addParameterValueById(breath, (Math.sin(time * 1.6) + 1) * 0.25)
      if (sway) model.addParameterValueById(sway, Math.sin(time * 0.8) * 1.2)
      const smooth = 1 - Math.exp(-delta * 8)
      gazeX += ((view.gaze ? targetX : 0) - gazeX) * smooth
      gazeY += ((view.gaze ? targetY : 0) - gazeY) * smooth
      for (const [name, value] of [['ParamAngleX', gazeX * 15], ['ParamAngleY', gazeY * 10], ['ParamEyeBallX', gazeX], ['ParamEyeBallY', gazeY]]) if (names.has(name)) model.addParameterValueById(names.get(name), value)
      user._physics?.evaluate(model, delta)
      user._pose?.updateParameters(model, delta)
      model.update()
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      const projection = new CubismMatrix44()
      projection.scale(height / width, 1)
      projection.multiplyByMatrix(matrix)
      renderer.setMvpMatrix(projection)
      renderer.setRenderState(null, [0, 0, width, height])
      renderer.drawModel()
    }
    signal.throwIfAborted()
    return { frame, resize, release, configure, look, setExpression, setIdleMotion, playMotion, capabilities, setMouth }
  } catch (error) { release(); throw error }
}
