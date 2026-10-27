<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Live2DStage from './Live2DStage.vue'
import type { StageCue, StagePresentation } from '../../shared/live2d'
import { actFor } from '../live2d/director'
import { bustOf } from '../../shared/live2d'
import { expressionLabel } from '../../shared/characters'
import type { ExpressionKey } from '../../shared/characters'

const props = defineProps<{ name: string; scene: string; expression: ExpressionKey; portraitUrl: string | null; backgroundUrl: string | null; characterId: string; presentation: StagePresentation; modelUrl: string | null; conversationId: string; messageId: string; cue: StageCue; mouth?: () => number }>()
// Image portraits zoom about a point near the top edge (heads sit there), so the head stays in frame;
// a higher focus moves that point closer to the top. The Live2D adapter eases its own camera.
const portraitFraming = computed(() => { const bust = bustOf(props.presentation); return props.presentation.framing === 'bust' ? { scale: String(bust.zoom), transformOrigin: `50% ${Math.round((1 - bust.focus) * 20)}%` } : {} })
const act = computed(() => actFor(props.presentation, props.conversationId, props.messageId, props.cue, props.expression))
const liveReady = ref(false), liveError = ref(''), attempt = ref(0)
const identity = computed(() => `${props.characterId}:${props.presentation.mode}:${props.modelUrl}:${attempt.value}`)
watch(identity, () => { liveReady.value = false; liveError.value = '' }, { flush: 'sync' })
function failed(message: string) { liveReady.value = false; liveError.value = message }
// Face variants for the built-in illustration: brows, mouth and blush strength.
const faces: Record<ExpressionKey, { brows: string; mouth: string; open?: boolean; blush: number }> = {
  neutral: { brows: 'M181 245C196 237 215 238 228 243M291 243C306 238 326 238 338 246', mouth: 'M246 321C254 323 266 323 276 320', blush: .5 },
  smile: { brows: 'M181 245C196 235 215 236 228 242M291 242C306 235 326 237 338 246', mouth: 'M242 319C252 326 268 326 280 317', blush: 1 },
  happy: { brows: 'M181 241C196 230 215 231 228 237M291 237C306 230 326 232 338 241', mouth: 'M240 316C250 333 271 333 282 315Z', open: true, blush: 1.3 },
  sad: { brows: 'M183 243C198 240 214 238 228 233M291 233C305 238 322 240 337 243', mouth: 'M245 326C254 319 268 319 277 326', blush: .4 },
  surprised: { brows: 'M181 236C196 226 215 227 228 233M291 233C306 226 326 228 338 237', mouth: 'M254 322C254 312 268 312 268 322C268 332 254 332 254 322Z', open: true, blush: .6 },
  shy: { brows: 'M183 244C198 239 214 239 228 241M291 241C305 239 322 239 337 244', mouth: 'M249 320C256 324 265 324 272 319', blush: 1.9 },
  angry: { brows: 'M181 237C196 240 215 244 228 251M291 251C306 244 325 240 338 237', mouth: 'M245 324C254 320 268 320 277 324', blush: .5 },
  thinking: { brows: 'M181 245C196 237 215 238 228 243M291 236C306 229 326 231 338 240', mouth: 'M252 322C258 320 266 321 273 324', blush: .6 },
}
const face = computed(() => faces[props.expression])
const label = computed(() => `${props.scene || '場景'}與角色${props.name}（${expressionLabel(props.expression)}）${liveReady.value ? '，Live2D' : props.portraitUrl ? '' : '，示意插畫'}`)
</script>

<template>
  <div class="scene-art" :aria-label="label" role="group">
    <Transition name="scene"><img v-if="backgroundUrl" :key="backgroundUrl" class="scene-background" :src="backgroundUrl" alt="" />
    <div v-else key="built-in" class="scene-built-in"><div class="bookcase"><div v-for="shelf in 4" :key="shelf" class="shelf"><i v-for="book in 13" :key="book" :style="{ '--book-height': `${42 + ((book * 17 + shelf * 11) % 38)}%`, '--book-hue': `${20 + ((book * 27) % 60)}` }"></i></div></div>
    <div class="window"><div class="distant-buildings"></div><div class="window-frame"></div></div><div class="sunlight"></div><div class="plant">❧</div><div class="counter"></div></div></Transition>
    <Transition name="expression"><img v-if="portraitUrl" v-show="!liveReady" :key="portraitUrl" class="character-portrait" :style="portraitFraming" :src="portraitUrl" alt="" />
    <svg v-else v-show="!liveReady" :key="`svg-${expression}`" class="character-art" viewBox="0 0 520 650" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="hair" x1="150" y1="100" x2="390" y2="490" gradientUnits="userSpaceOnUse"><stop stop-color="#483933"/><stop offset="1" stop-color="#241f24"/></linearGradient><linearGradient id="coat" x1="150" y1="410" x2="390" y2="620" gradientUnits="userSpaceOnUse"><stop stop-color="#e7d9be"/><stop offset="1" stop-color="#a8927b"/></linearGradient><linearGradient id="skin"><stop stop-color="#f6d9c4"/><stop offset="1" stop-color="#e8b59f"/></linearGradient><radialGradient id="blush"><stop stop-color="#d98e7d" stop-opacity=".55"/><stop offset="1" stop-color="#d98e7d" stop-opacity="0"/></radialGradient></defs>
      <path d="M131 247C119 127 177 70 260 73C361 63 400 163 383 287L421 508C365 552 152 550 104 500Z" fill="url(#hair)"/>
      <path d="M207 328L204 395L167 419L263 478L355 413L310 389L306 324" fill="url(#skin)"/>
      <path d="M199 376L259 417L317 376L381 411C420 460 436 556 445 650H76C83 540 105 453 144 414Z" fill="url(#coat)"/>
      <path d="M231 408L260 430L290 408L317 650H205Z" fill="#ede4d1"/><path d="M199 377L257 427L219 468L174 398ZM317 377L262 427L302 469L343 399Z" fill="#f6ebd6"/>
      <path d="M176 401L146 462L190 482L165 512L211 650M344 401L374 462L330 482L355 512L310 650" stroke="#99816e" stroke-width="3"/>
      <path d="M249 427L272 427L282 475L261 497L241 475Z" fill="#6b766b"/><path d="M260 495L243 632L271 644L281 626L266 495" fill="#59695d"/>
      <ellipse cx="155" cy="258" rx="17" ry="27" fill="#eac0a8"/><ellipse cx="365" cy="258" rx="17" ry="27" fill="#eac0a8"/>
      <path d="M156 204C167 135 344 128 363 205L353 289C340 333 289 367 261 365C227 366 177 328 166 288Z" fill="url(#skin)"/>
      <path d="M141 249C122 124 205 82 264 90C364 84 399 167 371 270L343 211C299 213 252 188 231 162C207 198 180 218 149 225L158 293Z" fill="url(#hair)"/>
      <path d="M230 126C224 173 207 190 181 205M246 118C245 169 284 189 327 199M270 117C286 151 319 170 348 177" stroke="#7c6350" stroke-opacity=".45" stroke-width="4" stroke-linecap="round"/>
      <path :d="face.brows" stroke="#5d4338" stroke-width="4" stroke-linecap="round"/>
      <path d="M178 263C193 250 217 252 230 264C212 281 193 281 178 263ZM290 264C304 252 328 252 342 264C326 281 305 281 290 264Z" fill="#fff6e9"/>
      <ellipse cx="206" cy="265" rx="10" ry="13" fill="#6a7968"/><ellipse cx="315" cy="265" rx="10" ry="13" fill="#6a7968"/><ellipse cx="207" cy="266" rx="4" ry="8" fill="#283b35"/><ellipse cx="314" cy="266" rx="4" ry="8" fill="#283b35"/><circle cx="202" cy="260" r="3" fill="#fff"/><circle cx="310" cy="260" r="3" fill="#fff"/>
      <path d="M177 262C190 250 215 250 231 263M289 263C305 250 330 251 343 263" stroke="#44322e" stroke-width="4" stroke-linecap="round"/>
      <g :style="{ opacity: Math.min(face.blush, 1) }"><ellipse cx="193" cy="291" :rx="26 * Math.max(1, face.blush * .8)" ry="13" fill="url(#blush)"/><ellipse cx="329" cy="291" :rx="26 * Math.max(1, face.blush * .8)" ry="13" fill="url(#blush)"/></g>
      <path d="M260 274L255 294L264 296" stroke="#c99480" stroke-width="2" stroke-linecap="round"/><path :d="face.mouth" stroke="#a56c61" stroke-width="3" stroke-linecap="round" :fill="face.open ? '#8c4f4b' : 'none'"/>
      <path d="M156 217C163 300 151 386 132 428M365 217C350 298 375 369 389 426" stroke="#342a2a" stroke-width="19" stroke-linecap="round"/>
      <path d="M353 201L370 195L376 214L358 221Z" fill="#b99a5e"/><path d="M354 208L375 204" stroke="#e8d39b" stroke-width="3"/>
      <path d="M121 548L205 505L292 558L277 650H144Z" fill="#6b7568"/><path d="M205 505L216 650M132 553L205 518L281 564" stroke="#b7b59b" stroke-width="3"/>
      <path d="M334 568C309 555 293 549 280 555C271 560 281 568 292 573C273 565 263 571 273 582L302 607L336 609" fill="url(#skin)"/><path d="M369 496L337 560L306 619L353 641L399 554" fill="url(#coat)" stroke="#ad9680" stroke-width="2"/>
    </svg></Transition>
    <div v-if="presentation.mode === 'live2d'" class="stage-live2d">
      <Live2DStage v-if="modelUrl && !liveError" :key="identity" :model-url="modelUrl" :view="presentation" :act="act" :mouth="mouth" @ready="liveReady = true" @failed="failed" />
      <div v-if="!liveReady" class="stage-live2d-status" role="status">{{ liveError || (modelUrl ? '正在載入 Live2D…' : '找不到模型索引，使用靜態立繪。') }}<button v-if="liveError" @click="attempt++">重試</button></div>
    </div>
    <div class="scene-grain"></div><div class="scene-vignette"></div>
  </div>
</template>
