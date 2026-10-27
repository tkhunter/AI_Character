import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { DEFAULT_MODEL, modelCapabilities, parseManifest } from '../src/live2d/model.ts'
import { MOTION_PRIORITY, actFor, autoMapping, createDirector, cueFor, mappedExpression } from '../src/live2d/director.ts'
import type { Performer } from '../src/live2d/director.ts'
import { defaultPresentation, parseMotionRef, presentationProblem } from '../shared/live2d.ts'
import type { StagePresentation } from '../shared/live2d.ts'

const base = { Version: 3, FileReferences: { Moc: 'Haru.moc3', Textures: ['t.png'] } }
const withRefs = (refs: object) => ({ ...base, FileReferences: { ...base.FileReferences, ...refs } })

test('manifest expressions and motions stay inside the package and are bounded', () => {
  const parsed = parseManifest(DEFAULT_MODEL, withRefs({
    Expressions: [{ Name: 'F01', File: 'expressions/F01.exp3.json' }],
    Motions: { Idle: [{ File: 'motion/idle.motion3.json', FadeInTime: 0.5 }], TapBody: [{ File: 'motion/tap.motion3.json', FadeOutTime: 99 }] },
  }))
  assert.deepEqual(parsed.expressions, [{ name: 'F01', file: '/live2d/local/models/Haru/expressions/F01.exp3.json' }])
  assert.deepEqual(parsed.motions.Idle, [{ file: '/live2d/local/models/Haru/motion/idle.motion3.json', fadeIn: 0.5 }])
  assert.deepEqual(parsed.motions.TapBody, [{ file: '/live2d/local/models/Haru/motion/tap.motion3.json' }], 'out-of-range fade times are ignored')
  assert.deepEqual(modelCapabilities(parsed), { expressions: ['F01'], motions: { Idle: 1, TapBody: 1 } })
  assert.deepEqual(parseManifest(DEFAULT_MODEL, base).expressions, [], 'models without expressions still load')
  // The official Mao keeps most motions in a group named "" — valid in Cubism, so it gets a usable name.
  assert.deepEqual(Object.keys(parseManifest(DEFAULT_MODEL, withRefs({ Motions: { Idle: [{ File: 'a.motion3.json' }], '': [{ File: 'b.motion3.json' }] } })).motions), ['Idle', '未分組'])
  assert.deepEqual(Object.keys(parseManifest(DEFAULT_MODEL, withRefs({ Motions: { '未分組': [{ File: 'a.motion3.json' }], '': [{ File: 'b.motion3.json' }] } })).motions), ['未分組', '未分組2'], 'never collides with a real group')
  for (const refs of [
    { Expressions: [{ Name: 'x', File: '../other/x.exp3.json' }] }, { Expressions: [{ Name: 'x', File: 'x.json' }] },
    { Expressions: [{ Name: 'x', File: 'a.exp3.json' }, { Name: 'x', File: 'b.exp3.json' }] }, { Expressions: Array.from({ length: 65 }, (_, i) => ({ Name: `e${i}`, File: `e${i}.exp3.json` })) },
    { Motions: { Idle: [{ File: 'https://host/m.motion3.json' }] } }, { Motions: { 'A:B': [{ File: 'm.motion3.json' }] } }, { Motions: { Idle: [{ File: 'm.js' }] } },
    { Motions: { Idle: Array.from({ length: 129 }, (_, i) => ({ File: `m${i}.motion3.json` })) } }, { Motions: [] },
  ]) assert.throws(() => parseManifest(DEFAULT_MODEL, withRefs(refs)), JSON.stringify(refs).slice(0, 60))
})

test('the installed Haru manifest exposes its expressions and motions when the SDK is prepared', { skip: !existsSync('public/live2d/local/models/Haru/Haru.model3.json') }, () => {
  const caps = modelCapabilities(parseManifest(DEFAULT_MODEL, JSON.parse(readFileSync('public/live2d/local/models/Haru/Haru.model3.json', 'utf8'))))
  assert.equal(caps.expressions.length, 8); assert.deepEqual(caps.motions, { Idle: 2, TapBody: 4 })
})

test('presentation maps are validated; old characters without maps stay valid', () => {
  const view: StagePresentation = { ...defaultPresentation(), mode: 'live2d', modelId: 'haru' }
  assert.equal(presentationProblem(view), '')
  assert.equal(presentationProblem({ ...view, expressionMap: { happy: 'F05' }, motionMap: { idle: 'Idle', reply: 'TapBody:2' } }), '')
  for (const bad of [{ expressionMap: { giggle: 'F01' } }, { expressionMap: { happy: '' } }, { expressionMap: [] }, { motionMap: { dance: 'Idle' } }, { motionMap: { reply: 'Tap:Body:1' } }, { motionMap: { reply: 'TapBody:abc' } }])
    assert.notEqual(presentationProblem({ ...view, ...bad }), '', JSON.stringify(bad))
  assert.deepEqual(parseMotionRef('TapBody:3'), { group: 'TapBody', index: 3 }); assert.deepEqual(parseMotionRef('Idle'), { group: 'Idle', index: null })
})

test('cues follow the reply on stage; missing expressions fall back to neutral', () => {
  assert.equal(cueFor({ status: 'generating', text: '', origin: 'model' }), 'thinking')
  assert.equal(cueFor({ status: 'generating', text: '', searches: ['天氣'], origin: 'model' }), 'searching')
  assert.equal(cueFor({ status: 'generating', text: '你', origin: 'model' }), 'reply')
  assert.equal(cueFor({ status: 'stopped', text: '你', origin: 'model' }), 'stopped')
  assert.equal(cueFor({ status: 'error', text: '', origin: 'model' }), 'stopped')
  assert.equal(cueFor({ status: 'complete', text: '你好', origin: 'model' }), 'idle')
  const view: StagePresentation = { ...defaultPresentation(), expressionMap: { neutral: 'F01', happy: 'F05' } }
  assert.equal(mappedExpression(view, 'happy'), 'F05'); assert.equal(mappedExpression(view, 'sad'), 'F01')
  assert.equal(mappedExpression(defaultPresentation(), 'sad'), null)
  assert.deepEqual(autoMapping({ expressions: ['Normal', 'Smile', 'Sad', 'Angry', 'Blushing', 'Surprised', 'exp_01'], motions: { Idle: 2, TapBody: 4 } }), {
    expressionMap: { neutral: 'Normal', smile: 'Smile', sad: 'Sad', surprised: 'Surprised', shy: 'Blushing', angry: 'Angry' }, motionMap: { idle: 'Idle' },
  })
})

test('the director plays whitelisted motions only on live cue changes for the same reply', () => {
  const calls: string[] = []
  const performer: Performer = {
    setExpression: name => { calls.push(`exp:${name}`) },
    setIdleMotion: group => { calls.push(`idle:${group}`) },
    playMotion: (group, index, priority) => { calls.push(`play:${group}:${index}:${priority}`); return true },
  }
  const view: StagePresentation = { ...defaultPresentation(), mode: 'live2d', modelId: 'haru', expressionMap: { neutral: 'F01', happy: 'F05' }, motionMap: { idle: 'Idle', thinking: 'TapBody:0', reply: 'TapBody:1', stopped: 'TapBody' } }
  const director = createDirector(performer)
  director.apply(actFor(view, 'c1', 'old', 'idle', 'smile'))
  assert.deepEqual(calls.splice(0), ['exp:F01', 'idle:Idle'], 'first act sets state but never plays a one-shot motion')
  director.apply(actFor(view, 'c2', 'b1', 'thinking', 'smile'))
  assert.deepEqual(calls.splice(0), [], 'switching to a conversation that is generating in the background plays nothing')
  director.apply(actFor(view, 'c2', 'old-stopped', 'stopped', 'smile'))
  assert.deepEqual(calls.splice(0), [], 'opening an old stopped reply from history does not replay the stop motion')
  director.apply(actFor(view, 'c2', 'm1', 'thinking', 'smile'))
  assert.deepEqual(calls.splice(0), [`play:TapBody:0:${MOTION_PRIORITY.normal}`], 'a new reply starting in the same conversation is live')
  director.apply(actFor(view, 'c2', 'm1', 'reply', 'happy'))
  assert.deepEqual(calls.splice(0), ['exp:F05', `play:TapBody:1:${MOTION_PRIORITY.normal}`])
  director.apply(actFor(view, 'c2', 'm1', 'reply', 'happy'))
  assert.deepEqual(calls.splice(0), [], 'unchanged acts are idempotent')
  director.apply(actFor(view, 'c2', 'm1', 'stopped', 'happy'))
  assert.deepEqual(calls.splice(0), [`play:TapBody:null:${MOTION_PRIORITY.force}`])
  director.apply(actFor(view, 'c2', 'm1', 'idle', 'happy'))
  assert.deepEqual(calls.splice(0), [], 'returning to idle relies on the idle loop instead of a one-shot motion')
  director.apply(actFor({ ...view, motionMap: {} }, 'c1', 'm2', 'thinking', 'happy'))
  assert.deepEqual(calls.splice(0), ['idle:null'])
})

test('framing is optional, validated, and toggled per character without touching other settings', async () => {
  const { createChatState } = await import('../src/composables/useChat.ts')
  const { bustOf, BUST_DEFAULTS } = await import('../shared/live2d.ts')
  const view: StagePresentation = { ...defaultPresentation(), mode: 'live2d', modelId: 'haru', expressionMap: { happy: 'F05' } }
  assert.equal(presentationProblem({ ...view, framing: 'bust', bustZoom: 2.5, bustFocus: 0.7 }), '')
  for (const bad of [{ framing: 'half' }, { bustZoom: 1 }, { bustZoom: 9 }, { bustFocus: -0.1 }, { bustFocus: Number.NaN }])
    assert.notEqual(presentationProblem({ ...view, ...bad }), '', JSON.stringify(bad))
  assert.deepEqual(bustOf(view), { zoom: BUST_DEFAULTS.zoom, focus: BUST_DEFAULTS.focus })
  const chat = createChatState(async () => Response.json({ connected: true, model: 't', endpoint: '' }))
  try {
    const id = chat.activeCharacter.value.id
    chat.activeCharacter.value.presentation = view
    chat.setFraming(id, 'bust')
    assert.equal(chat.activeCharacter.value.presentation.framing, 'bust')
    assert.deepEqual(chat.activeCharacter.value.presentation.expressionMap, { happy: 'F05' }, 'other presentation settings are kept')
    chat.setFraming(id, 'full'); assert.equal(chat.activeCharacter.value.presentation.framing, 'full')
  } finally { chat.dispose() }
})
