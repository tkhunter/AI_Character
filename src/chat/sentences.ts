import { characters as graphemes } from './model.ts'

/** Sentence enders, optionally followed by closing quotes/brackets. Repeated enders ("……", "！？") stay together. */
const END = /[。！？!?…\n]/
const CLOSERS = /[」』"'”’）)\]】〉》]/
const SOFT = /[，、；：,;:]/

export type Sentence = { text: string; graphemes: number }
/**
 * Splits streamed dialogue into speakable sentences. Every character pushed comes out exactly once,
 * in order, so the running grapheme total lines up with the text on screen. A boundary at the very
 * end of the buffer waits for more input, because the next delta may continue it ("…" + "…", "。」").
 */
export function createSentenceSplitter(options: { min?: number; max?: number; firstSoft?: number } = {}) {
  const min = options.min ?? 6, max = options.max ?? 60
  // The first chunk may end at a comma once it has this many characters, so speech starts sooner.
  const firstSoft = options.firstSoft ?? 8
  let buffer = '', emitted = 0
  const take = (end: number): Sentence => { const text = buffer.slice(0, end); buffer = buffer.slice(end); emitted++; return { text, graphemes: graphemes(text).length } }
  const spoken = (text: string) => graphemes(text.replace(/\s+/g, '')).length
  function boundary(from: number) {
    for (let i = from; i < buffer.length; i++) {
      if (!END.test(buffer[i]!)) continue
      let end = i + 1
      while (end < buffer.length && (END.test(buffer[end]!) || CLOSERS.test(buffer[end]!))) end++
      return end
    }
    return -1
  }
  function push(delta: string, final = false): Sentence[] {
    buffer += delta
    const out: Sentence[] = []
    for (;;) {
      let end = boundary(0)
      // Very short pieces ("嗯。") join the next sentence so speech does not stutter.
      while (end > 0 && spoken(buffer.slice(0, end)) < min && buffer.slice(0, end).trim()) {
        const next = boundary(end)
        if (next < 0) { end = -1; break }
        end = next
      }
      if (end > 0 && (end < buffer.length || final)) { out.push(take(end)); continue }
      if (!emitted && firstSoft > 0) {
        let soft = -1
        for (let i = 0; i < buffer.length - 1; i++) if (SOFT.test(buffer[i]!) && spoken(buffer.slice(0, i + 1)) >= firstSoft) { soft = i + 1; break }
        if (soft > 0) { out.push(take(soft)); continue }
      }
      // No sentence end for a while: break at the last soft pause, else at the length cap.
      if (graphemes(buffer).length > max) {
        const soft = [...buffer.slice(0, Math.floor(buffer.length * 0.9))].reduce((at, ch, i) => SOFT.test(ch) ? i + 1 : at, -1)
        out.push(take(soft > 0 ? soft : buffer.length)); continue
      }
      break
    }
    if (final && buffer) out.push(take(buffer.length))
    return out
  }
  return { push, flush: () => push('', true), pending: () => buffer }
}
/** Text actually sent to TTS; whitespace-only pieces (blank lines) are timed but not voiced. */
export const speakable = (text: string) => text.replace(/\s+/g, ' ').trim()
