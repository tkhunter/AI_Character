import { ref } from 'vue'
import type { Character } from '../../shared/characters.ts'
import { speakable } from './sentences.ts'
import type { Sentence } from './sentences.ts'

export type VoiceEngine = 'browser' | 'http'
/** `requesting` covers waiting for TTS audio or for the browser to start speaking; only `playing` moves the mouth. */
export type VoicePhase = 'idle' | 'requesting' | 'playing'
/** Where the mouth level comes from: measured audio volume, or a labelled approximation for browser speech. */
export type LipSource = 'audio' | 'simulated' | null

/** RMS volume of one analyser frame mapped to 0–1, ignoring a small noise floor. */
export function rmsLevel(samples: ArrayLike<number>) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return Math.max(0, Math.min(1, (rms - 0.015) * 7))
}
/** Open quickly, close a little slower, so speech reads as syllables rather than flicker. */
export function smoothMouth(previous: number, target: number, seconds: number) {
  const rate = target > previous ? 28 : 14
  return previous + (target - previous) * (1 - Math.exp(-rate * Math.max(0, seconds)))
}
/** Browser speech gives no audio stream, so this is a syllable-like rhythm, not a measured sync. */
export function simulatedMouth(seconds: number) {
  const syllable = Math.max(0, Math.sin(seconds * Math.PI * 2 * 4.2))
  const phrase = 0.65 + 0.35 * Math.sin(seconds * Math.PI * 2 * 0.9)
  return Math.min(1, syllable * phrase)
}

type AudioLike = Pick<HTMLAudioElement, 'play' | 'pause' | 'src'> & { onended: (() => void) | null; onerror: (() => void) | null; currentTime?: number; duration?: number }
type StreamItem = { graphemes: number; audio: Promise<Blob | null> | null; element: AudioLike | null; url: string }
export type VoiceDeps = {
  fetcher: typeof fetch
  synth?: SpeechSynthesis | null
  createAudio?: (url: string) => AudioLike
  /** Returns null when Web Audio is unavailable; the mouth then falls back to the simulated rhythm. */
  createContext?: () => AudioContext | null
  now?: () => number
}
/** Browser Web Speech with an optional local TTS server; one utterance plays at a time. */
export function createVoice(input: typeof fetch | VoiceDeps) {
  const deps: VoiceDeps = typeof input === 'function' ? { fetcher: input } : input
  const fetcher = deps.fetcher
  const now = deps.now ?? (() => performance.now() / 1000)
  const speaking = ref<string | null>(null), phase = ref<VoicePhase>('idle'), lipSource = ref<LipSource>(null), owner = ref<string | null>(null)
  const error = ref(''), voices = ref<{ uri: string; name: string; lang: string }[]>([])
  const synth = deps.synth !== undefined ? deps.synth : typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
  const supported = !!synth
  const createAudio = deps.createAudio ?? (url => new Audio(url) as unknown as AudioLike)
  const createContext = deps.createContext ?? (() => { const Ctor = typeof window !== 'undefined' ? window.AudioContext : undefined; return Ctor ? new Ctor() : null })
  let audio: AudioLike | null = null, request: AbortController | null = null, token = 0, url = ''
  let context: AudioContext | null | undefined, analyser: AnalyserNode | null = null, source: AudioNode | null = null, samples: Float32Array<ArrayBuffer> | null = null
  let mouthValue = 0, lastMouth = 0, playStarted = 0
  // Sentence-by-sentence speech while a reply is still generating: audio is requested as soon as a
  // sentence is complete and played strictly in order; `spokenBefore` counts graphemes already voiced.
  let stream: { id: string; mine: number; character: Character; items: StreamItem[]; index: number; ended: boolean; busy: boolean; spokenBefore: number; failed: boolean; started: boolean } | null = null
  const streamAborts = new Set<AbortController>()
  function loadVoices() {
    if (!synth) return
    // Chinese voices first; the list arrives asynchronously in some browsers.
    voices.value = synth.getVoices().map(v => ({ uri: v.voiceURI, name: v.name, lang: v.lang }))
      .sort((a, b) => Number(!/^zh/i.test(a.lang)) - Number(!/^zh/i.test(b.lang)) || a.lang.localeCompare(b.lang))
  }
  if (synth) { loadVoices(); synth.addEventListener?.('voiceschanged', loadVoices) }
  function finish() { speaking.value = null; phase.value = 'idle'; lipSource.value = null; owner.value = null }
  function stop() {
    token++; request?.abort(); request = null
    synth?.cancel()
    if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); audio = null }
    if (url) { URL.revokeObjectURL(url); url = '' }
    if (stream) for (const item of stream.items) { if (item.element) { item.element.onended = null; item.element.onerror = null; item.element.pause() } if (item.url) URL.revokeObjectURL(item.url) }
    stream = null
    for (const controller of streamAborts) controller.abort()
    streamAborts.clear()
    source?.disconnect(); source = null
    // Stopping closes the mouth at once instead of letting it ease shut.
    mouthValue = 0
    finish()
  }
  /** Route the element through an analyser; returns false when Web Audio cannot measure it. */
  async function analyse(element: AudioLike) {
    if (context === undefined) { try { context = createContext() } catch { context = null } }
    if (!context) return false
    try {
      if (context.state === 'suspended') await context.resume()
      if (context.state !== 'running') return false
      analyser ??= Object.assign(context.createAnalyser(), { fftSize: 1024 })
      samples ??= new Float32Array(analyser.fftSize)
      source = context.createMediaElementSource(element as HTMLMediaElement)
      source.connect(analyser); analyser.connect(context.destination)
      return true
    } catch { source = null; return false }
  }
  async function speak(id: string, text: string, character: Character, engine: VoiceEngine, conversationId: string | null = null) {
    stop(); error.value = ''
    if (!text.trim()) return false
    const mine = ++token
    speaking.value = id; phase.value = 'requesting'; owner.value = conversationId
    const done = () => { if (token === mine) { mouthValue = 0; finish() } }
    const started = (from: LipSource) => { if (token !== mine) return; phase.value = 'playing'; lipSource.value = from; playStarted = now(); lastMouth = now() }
    if (engine === 'http') {
      // Create/resume Web Audio before the first await, while still inside the click that asked to speak.
      if (context === undefined) { try { context = createContext() } catch { context = null } }
      void context?.resume?.().catch(() => {})
      try {
        request = new AbortController()
        const response = await fetcher('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: character.id, text, voice: character.voice.httpVoice, speed: character.voice.rate }), signal: request.signal })
        if (!response.ok) throw new Error((await response.json()).error || '語音生成失敗。')
        const blob = await response.blob()
        if (token !== mine) return false
        url = URL.createObjectURL(blob)
        const element = createAudio(url); audio = element
        element.onended = done; element.onerror = () => { if (token === mine) error.value = '無法播放語音。'; done() }
        const measured = await analyse(element)
        if (token !== mine) return false
        await element.play()
        started(measured ? 'audio' : 'simulated')
        return true
      } catch (cause) {
        if (token === mine) { error.value = cause instanceof Error && cause.name !== 'AbortError' ? cause.message : ''; done() }
        return false
      }
    }
    if (!synth) { error.value = '這個瀏覽器不支援語音朗讀。'; done(); return false }
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = synth.getVoices().find(v => v.voiceURI === character.voice.browserVoice) ?? synth.getVoices().find(v => /^zh[-_](TW|Hant)/i.test(v.lang)) ?? synth.getVoices().find(v => /^zh/i.test(v.lang))
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang } else utterance.lang = 'zh-TW'
    utterance.rate = character.voice.rate; utterance.pitch = character.voice.pitch
    utterance.onstart = () => started('simulated')
    utterance.onend = done; utterance.onerror = event => { if (event.error !== 'interrupted' && event.error !== 'canceled' && token === mine) error.value = '語音朗讀失敗。'; done() }
    synth.speak(utterance); return true
  }
  function primeAudio() {
    // Create/resume Web Audio as early as possible; the page has already been interacted with.
    if (context === undefined) { try { context = createContext() } catch { context = null } }
    void context?.resume?.().catch(() => {})
  }
  /** Start speaking a reply that is still being generated; feed it with enqueue() and close it with endStream(). */
  function beginStream(id: string, character: Character, conversationId: string | null = null) {
    stop(); error.value = ''
    const mine = ++token
    speaking.value = id; phase.value = 'requesting'; owner.value = conversationId
    primeAudio()
    stream = { id, mine, character: { ...character, voice: { ...character.voice } }, items: [], index: 0, ended: false, busy: false, spokenBefore: 0, failed: false, started: false }
  }
  function fetchSentence(text: string, character: Character, mine: number) {
    const controller = new AbortController(); streamAborts.add(controller)
    return fetcher('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: character.id, text, voice: character.voice.httpVoice, speed: character.voice.rate }), signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error((await response.json()).error || '語音生成失敗。'); return await response.blob() })
      .catch((cause: unknown) => {
        if (token === mine && !(cause instanceof Error && cause.name === 'AbortError')) { error.value = cause instanceof Error ? cause.message : '語音生成失敗。'; if (stream?.mine === mine) stream.failed = true }
        return null
      })
      .finally(() => streamAborts.delete(controller))
  }
  function enqueue(sentence: Sentence) {
    const s = stream
    if (!s) return
    const text = speakable(sentence.text)
    s.items.push({ graphemes: sentence.graphemes, audio: text ? fetchSentence(text, s.character, s.mine) : null, element: null, url: '' })
    void pump()
  }
  function endStream() { if (stream) { stream.ended = true; void pump() } }
  function advance(s: NonNullable<typeof stream>) {
    const item = s.items[s.index]
    if (item?.element) { item.element.onended = null; item.element.onerror = null }
    if (item?.url) { URL.revokeObjectURL(item.url); item.url = '' }
    source?.disconnect(); source = null
    s.spokenBefore += item?.graphemes ?? 0
    s.index++; s.busy = false
    void pump()
  }
  async function pump() {
    const s = stream
    if (!s || s.busy) return
    if (s.index >= s.items.length) {
      if (s.ended) { mouthValue = 0; stream = null; finish() }
      return
    }
    s.busy = true
    const item = s.items[s.index]!
    const blob = item.audio ? await item.audio : null
    if (stream !== s) return
    // Blank lines (no audio) and failed sentences are skipped; their text is released at once.
    if (!blob) { advance(s); return }
    item.url = URL.createObjectURL(blob)
    const element = createAudio(item.url); item.element = element
    element.onended = () => advance(s); element.onerror = () => { s.failed = true; advance(s) }
    const measured = await analyse(element)
    if (stream !== s) return
    try { await element.play() } catch { s.failed = true; advance(s); return }
    if (stream !== s) return
    // Stay "playing" between sentences; the mouth simply closes while the next one starts.
    phase.value = 'playing'; lipSource.value = measured ? 'audio' : 'simulated'
    if (!s.started) { s.started = true; playStarted = now(); lastMouth = now() }
  }
  /**
   * Graphemes of reply `id` voiced so far (finished sentences plus the playing one, in proportion to
   * its playback), or null when no healthy stream is speaking that reply; callers then fall back to
   * the normal typewriter speed.
   */
  function spokenGraphemes(id: string) {
    const s = stream
    if (!s || s.id !== id || s.failed) return null
    const item = s.items[s.index], el = item?.element
    const fraction = el && el.duration && Number.isFinite(el.duration) ? Math.min(1, Math.max(0, (el.currentTime ?? 0) / el.duration)) : 0
    return s.spokenBefore + Math.floor((item?.graphemes ?? 0) * fraction)
  }
  const streaming = (id: string) => stream?.id === id
  /** Current mouth opening (0–1); read once per rendered frame by the stage. */
  function mouth() {
    const t = now(), dt = Math.min(0.1, Math.max(0, t - lastMouth)); lastMouth = t
    let target = 0
    if (phase.value === 'playing') {
      if (lipSource.value === 'audio' && analyser && samples) { analyser.getFloatTimeDomainData(samples); target = rmsLevel(samples) }
      else if (lipSource.value === 'simulated') target = synth?.paused ? 0 : simulatedMouth(t - playStarted)
    }
    mouthValue = smoothMouth(mouthValue, target, dt)
    return mouthValue < 0.01 ? 0 : mouthValue
  }
  function dispose() { stop(); synth?.removeEventListener?.('voiceschanged', loadVoices); void context?.close?.(); context = undefined; analyser = null }
  return { supported, speaking, phase, lipSource, owner, error, voices, speak, stop, mouth, dispose, beginStream, enqueue, endStream, spokenGraphemes, streaming }
}
