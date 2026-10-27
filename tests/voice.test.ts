import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVoice, rmsLevel, simulatedMouth, smoothMouth } from '../src/chat/voice.ts'
import { defaultCharacter } from '../shared/characters.ts'

test('volume maps to mouth opening with a noise floor; opening is faster than closing', () => {
  assert.equal(rmsLevel(new Float32Array(512)), 0)
  assert.equal(rmsLevel(new Float32Array(512).fill(0.01)), 0, 'background hiss keeps the mouth shut')
  assert.equal(rmsLevel(new Float32Array(512).fill(0.9)), 1)
  const mid = rmsLevel(new Float32Array(512).fill(0.08)); assert.ok(mid > 0.3 && mid < 0.6, String(mid))
  const opened = smoothMouth(0, 1, 1 / 30), closed = 1 - smoothMouth(1, 0, 1 / 30)
  assert.ok(opened > closed && opened < 1 && closed > 0)
  assert.equal(smoothMouth(0.4, 1, 0), 0.4)
  const values = Array.from({ length: 100 }, (_, i) => simulatedMouth(i / 30))
  assert.ok(values.every(v => v >= 0 && v <= 1) && Math.max(...values) > 0.6 && values.some(v => v === 0), 'syllable-like rhythm with closed gaps')
})

function fakes(options: { context?: boolean } = {}) {
  let clock = 0, release: () => void = () => {}
  const gate = new Promise<void>(done => { release = done })
  const element = { src: '', onended: null as (() => void) | null, onerror: null as (() => void) | null, paused: true, play: async () => { element.paused = false }, pause: () => { element.paused = true } }
  const connections: string[] = []
  const context = {
    state: 'suspended', destination: {},
    resume: async () => { context.state = 'running' },
    close: async () => {},
    createAnalyser: () => ({ fftSize: 1024, connect: () => connections.push('analyser→out'), getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0.2) }),
    createMediaElementSource: () => ({ connect: () => connections.push('source→analyser'), disconnect: () => connections.push('disconnect') }),
  }
  const voice = createVoice({
    fetcher: async () => { await gate; return new Response(new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' })) },
    synth: null, now: () => clock,
    createAudio: url => { element.src = url; return element },
    createContext: () => options.context === false ? null : context as unknown as AudioContext,
  })
  return { voice, element, connections, release, tick: (seconds: number) => { clock += seconds; return voice.mouth() } }
}

test('local TTS separates requesting from playing and drives the mouth from measured audio', async () => {
  const f = fakes()
  const speaking = f.voice.speak('m1', '你好', defaultCharacter(), 'http', 'c1')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(f.voice.phase.value, 'requesting'); assert.equal(f.voice.speaking.value, 'm1'); assert.equal(f.voice.owner.value, 'c1')
  assert.equal(f.tick(0.1), 0, 'waiting for audio never moves the mouth')
  f.release(); assert.equal(await speaking, true)
  assert.equal(f.voice.phase.value, 'playing'); assert.equal(f.voice.lipSource.value, 'audio')
  assert.deepEqual(f.connections, ['source→analyser', 'analyser→out'], 'audio is routed through the analyser to the speakers')
  let level = 0; for (let i = 0; i < 10; i++) level = f.tick(1 / 30)
  assert.ok(level > 0.8, `measured level opens the mouth (${level})`)
  f.element.onended!()
  assert.equal(f.voice.phase.value, 'idle'); assert.equal(f.voice.owner.value, null)
  assert.equal(f.tick(1 / 30), 0, 'the mouth closes as soon as playback ends')
})

test('stopping closes the mouth at once; without Web Audio the mouth is labelled simulated', async () => {
  const f = fakes(); f.release()
  await f.voice.speak('m1', '你好', defaultCharacter(), 'http', 'c1')
  for (let i = 0; i < 5; i++) f.tick(1 / 30)
  f.voice.stop()
  assert.equal(f.voice.phase.value, 'idle'); assert.equal(f.tick(1 / 30), 0); assert.ok(f.element.paused)
  assert.ok(f.connections.includes('disconnect'))
  const plain = fakes({ context: false }); plain.release()
  await plain.voice.speak('m2', '你好', defaultCharacter(), 'http', 'c1')
  assert.equal(plain.voice.lipSource.value, 'simulated')
  let peak = 0; for (let i = 0; i < 30; i++) peak = Math.max(peak, plain.tick(1 / 30))
  assert.ok(peak > 0.3, 'simulated rhythm still animates')
})

test('a newer request supersedes an older one that is still downloading', async () => {
  const f = fakes()
  const first = f.voice.speak('old', '第一句', defaultCharacter(), 'http', 'c1')
  await new Promise(r => setTimeout(r, 0))
  f.voice.stop()
  f.release()
  assert.equal(await first, false)
  assert.equal(f.voice.phase.value, 'idle'); assert.equal(f.voice.speaking.value, null)
})
