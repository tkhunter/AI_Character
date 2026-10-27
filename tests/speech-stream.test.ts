import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSentenceSplitter, speakable } from '../src/chat/sentences.ts'
import { createVoice } from '../src/chat/voice.ts'
import { characters } from '../src/chat/model.ts'
import { defaultCharacter } from '../shared/characters.ts'

test('streamed text splits into sentences without losing or reordering a single character', () => {
  const deltas = ['嗯。', '今天的天', '氣很好……', '我們去散步吧！', '\n\n你覺得呢', '？要不要', '帶傘🌂」', '呢。最後一句']
  const s = createSentenceSplitter({ firstSoft: 0 }), out: string[] = []
  const pushed: string[][] = deltas.map(d => s.push(d).map(x => x.text))
  pushed.forEach(p => out.push(...p))
  out.push(...s.flush().map(x => x.text))
  assert.equal(out.join(''), deltas.join(''), 'concatenation is lossless')
  assert.deepEqual(out, ['嗯。今天的天氣很好……', '我們去散步吧！\n\n', '你覺得呢？要不要帶傘🌂」呢。', '最後一句'])
  assert.deepEqual(pushed[1], [], 'nothing is emitted before a sentence ends')
  assert.deepEqual(pushed[2], [], 'an ender at the end of the buffer waits: the next delta may continue it')
  const counted = createSentenceSplitter().push('你好🌂。再見。', true)
  assert.deepEqual(counted.map(x => x.graphemes), [characters('你好🌂。再見。').length], 'graphemes match the stage typewriter (emoji is one)')
  const long = createSentenceSplitter({ max: 20 }).push('這是一段沒有句號的很長很長的文字，會在逗號那裡被切開然後繼續說下去還有更多')
  assert.ok(long.length >= 1 && long[0]!.text.endsWith('，'), 'over-long runs break at a soft pause')
  const quick = createSentenceSplitter()
  assert.deepEqual(quick.push('我最喜歡秋天，因為').map(x => x.text), [], 'a first clause shorter than 8 characters waits')
  assert.deepEqual(quick.push('那時候的空氣很涼，帶').map(x => x.text), ['我最喜歡秋天，因為那時候的空氣很涼，'], 'the first chunk may end at a comma once long enough, so speech starts sooner')
  assert.deepEqual(quick.push('著桂花香，真好。下').map(x => x.text), ['帶著桂花香，真好。'], 'later chunks only end at sentence ends')
  assert.equal(speakable('  你好\n\n  '), '你好'); assert.equal(speakable('\n\n'), '')
})

function streamFakes() {
  const requests: { text: string; voice: string; resolve: (ok: boolean) => void }[] = []
  const elements: { src: string; currentTime: number; duration: number; onended: (() => void) | null; onerror: (() => void) | null; play: () => Promise<void>; pause: () => void; playing: boolean }[] = []
  const voice = createVoice({
    synth: null, createContext: () => null, now: () => 0,
    fetcher: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const ok = await new Promise<boolean>(resolve => requests.push({ text: body.text, voice: body.voice, resolve }))
      return ok ? new Response(new Blob([body.text])) : Response.json({ error: 'TTS down' }, { status: 502 })
    }) as typeof fetch,
    createAudio: url => { const el = { src: url, currentTime: 0, duration: 2, onended: null, onerror: null, playing: false, play: async () => { el.playing = true }, pause: () => { el.playing = false } }; elements.push(el); return el },
  })
  const settle = () => new Promise(r => setTimeout(r, 0))
  return { voice, requests, elements, settle }
}

test('sentences are synthesised ahead, played strictly in order, and text follows the playback position', async () => {
  const f = streamFakes(), character = { ...defaultCharacter(), voice: { ...defaultCharacter().voice, httpVoice: 'zf_003' } }
  f.voice.beginStream('m1', character, 'c1')
  assert.equal(f.voice.spokenGraphemes('m1'), 0); assert.equal(f.voice.spokenGraphemes('other'), null)
  f.voice.enqueue({ text: '第一句話。', graphemes: 5 }); f.voice.enqueue({ text: '\n\n', graphemes: 2 }); f.voice.enqueue({ text: '第二句。', graphemes: 4 })
  await f.settle()
  assert.deepEqual(f.requests.map(r => [r.text, r.voice]), [['第一句話。', 'zf_003'], ['第二句。', 'zf_003']], 'both sentences requested at once; the blank line is not voiced')
  f.requests[1]!.resolve(true); await f.settle()
  assert.equal(f.elements.length, 0, 'a later sentence never plays before an earlier one')
  f.requests[0]!.resolve(true); await f.settle(); await f.settle()
  assert.equal(f.elements.length, 1); assert.ok(f.elements[0]!.playing); assert.equal(f.voice.phase.value, 'playing')
  f.elements[0]!.currentTime = 1; assert.equal(f.voice.spokenGraphemes('m1'), 2, 'half of the first sentence')
  f.elements[0]!.onended!(); await f.settle(); await f.settle()
  assert.equal(f.voice.spokenGraphemes('m1'), 7, 'first sentence plus the instantly released blank line')
  assert.equal(f.elements.length, 2)
  f.voice.endStream()
  assert.equal(f.voice.phase.value, 'playing', 'the stream stays open until the queue drains')
  f.elements[1]!.onended!(); await f.settle(); await f.settle()
  assert.equal(f.voice.phase.value, 'idle'); assert.equal(f.voice.spokenGraphemes('m1'), null, 'finished: the typewriter takes over again')
})

test('a failed sentence hands the text back to the normal typewriter; stop clears the whole queue', async () => {
  const f = streamFakes()
  f.voice.beginStream('m1', defaultCharacter(), 'c1')
  f.voice.enqueue({ text: '會失敗的一句。', graphemes: 7 }); await f.settle()
  f.requests[0]!.resolve(false); await f.settle(); await f.settle()
  assert.equal(f.voice.spokenGraphemes('m1'), null); assert.match(f.voice.error.value, /TTS down/)
  const g = streamFakes()
  g.voice.beginStream('m2', defaultCharacter(), 'c1')
  g.voice.enqueue({ text: '一。二三四五六。', graphemes: 8 }); g.voice.enqueue({ text: '後面還有很多句。', graphemes: 8 }); await g.settle()
  g.requests[0]!.resolve(true); await g.settle(); await g.settle()
  g.voice.stop()
  assert.equal(g.voice.phase.value, 'idle'); assert.ok(!g.elements[0]!.playing)
  g.requests[1]!.resolve(true); await g.settle(); await g.settle()
  assert.equal(g.elements.length, 1, 'nothing queued before stop() plays afterwards')
})
