import { parseMotionRef } from '../../shared/live2d.ts'
import type { StageCue, StagePresentation } from '../../shared/live2d.ts'
import type { ExpressionKey } from '../../shared/characters.ts'

export const MOTION_PRIORITY = { idle: 1, normal: 2, force: 3 } as const
/** What the adapter must offer; everything is a no-op for names the model does not have. */
export type Performer = {
  setExpression: (name: string | null) => void
  setIdleMotion: (group: string | null) => void
  playMotion: (group: string, index: number | null, priority: number) => boolean
}
/** One snapshot of the active conversation's stage state. */
export type Act = { conversationId: string; messageId: string; cue: StageCue; expression: string | null; idleMotion: string | null; cueMotion: string | null }

/** Chat expression → model expression name, falling back to the neutral mapping, then to none. */
export function mappedExpression(view: StagePresentation, expression: ExpressionKey) {
  return view.expressionMap?.[expression] ?? view.expressionMap?.neutral ?? null
}
export function actFor(view: StagePresentation, conversationId: string, messageId: string, cue: StageCue, expression: ExpressionKey): Act {
  return { conversationId, messageId, cue, expression: mappedExpression(view, expression), idleMotion: view.motionMap?.idle ?? null, cueMotion: cue === 'idle' ? null : view.motionMap?.[cue] ?? null }
}
const HINTS: Record<ExpressionKey, RegExp> = {
  neutral: /normal|neutral|default|平常|普通/i, smile: /smile|微笑/i, happy: /happy|joy|laugh|開心|笑/i, sad: /sad|cry|悲|哭|難過/i,
  surprised: /surpris|shock|驚/i, shy: /shy|blush|照れ|害羞|臉紅/i, angry: /angry|mad|怒|生氣/i, thinking: /think|ponder|考|思考/i,
}
/** Suggest mappings from names (e.g. Natori's Smile/Sad/Angry); unmatched entries stay empty for the user to choose. */
export function autoMapping(caps: { expressions: string[]; motions: Record<string, number> }) {
  const expressionMap: Partial<Record<ExpressionKey, string>> = {}
  for (const [key, hint] of Object.entries(HINTS) as [ExpressionKey, RegExp][]) {
    const found = caps.expressions.find(name => hint.test(name))
    if (found) expressionMap[key] = found
  }
  const idle = Object.keys(caps.motions).find(group => /idle/i.test(group))
  return { expressionMap, motionMap: idle ? { idle } : {} }
}
/** Derive the cue from the reply on stage. Background conversations never reach here: only the active one is displayed. */
export function cueFor(message: { status: string; text: string; searches?: string[]; origin: string }): StageCue {
  if (message.status === 'generating') return message.text ? 'reply' : message.searches?.length ? 'searching' : 'thinking'
  if (message.status === 'stopped' || message.status === 'error') return 'stopped'
  return 'idle'
}
const GENERATING = new Set<StageCue>(['thinking', 'searching', 'reply'])
/**
 * Applies acts to one loaded model. A one-shot motion plays only for live changes inside the same
 * conversation: the cue of the reply on stage changes, or a new reply starts generating. Switching
 * conversations, opening history or reloading a model never replays an old motion.
 */
export function createDirector(performer: Performer) {
  let last: Act | null = null
  function apply(act: Act) {
    if (!last || last.expression !== act.expression) performer.setExpression(act.expression)
    if (!last || last.idleMotion !== act.idleMotion) performer.setIdleMotion(act.idleMotion ? parseMotionRef(act.idleMotion)?.group ?? null : null)
    const sameConversation = !!last && last.conversationId === act.conversationId
    const live = sameConversation && (last!.messageId === act.messageId ? last!.cue !== act.cue : GENERATING.has(act.cue))
    if (live && act.cueMotion) {
      const ref = parseMotionRef(act.cueMotion)
      if (ref) performer.playMotion(ref.group, ref.index, act.cue === 'stopped' ? MOTION_PRIORITY.force : MOTION_PRIORITY.normal)
    }
    last = { ...act }
  }
  return { apply }
}
