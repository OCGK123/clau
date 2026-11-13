// 대화는 크기가 고정된 별도 투명 창에 산다(캐릭터 창은 열고 닫을 때 크기·위치가 바뀌지 않는다).
// 말풍선은 꼬리 끝(펫 머리)에서 작은 방울로 퐁 부풀어 젤리처럼 자리 잡고, 닫힐 땐 그 자리로 쏙 들어간다.
// 애니메이션 자체는 bubble.css가 맡고, 여기서는 단계(phase)와 창 수명만 관리한다.
const el = id => document.getElementById(id)
const dialog = el('dialog')
const answer = el('answer')
const form = el('ask')
const input = el('q')
const send = el('send')
const cancel = el('cancel')
const close = el('closeBubble')
const sound = window.ClauSound.create()
const REVEAL_CPS = 38 // 대답 글자가 나타나는 빠르기(글자/초). 밀린 글자가 많으면 더 빨리 따라잡는다.
const HINT = '안녕! 난 클로야. 만나서 반가워!!!!!!'
const OPEN_MS = 460 // bubble.css bubble-in 길이와 맞춘다
const CLOSE_MS = 240 // bubble.css bubble-out 길이와 맞춘다
const TAIL_EDGE_PX = 22 // 꼬리가 둥근 모서리에 걸리지 않게

let cfg = { bubbleSeconds: 30, reduceMotion: false, chatEnabled: true }
let layout = { width: 384, height: 248, originX: 192, originY: 246, side: 'above' }
let open = false
let shown = document.visibilityState !== 'hidden'
let busy = false
let phase = 'closed' // 'opening' | 'open' | 'closing' | 'closed'
let phaseTimer = null
let reveal = { chars: [], count: 0, frame: null, last: 0, carry: 0 } // 한 글자씩 나타내기
let autoTimer = null
let lastTouch = Date.now()
let limitUntil = 0
let replied = false // 이번 질문의 대답이 화면에 나타났는가(효과음 한 번만)
let providerState = null

function showProvider(state) {
  providerState = state
  const label = el('providerName')
  if (label) label.textContent = `${{claude:'Claude Code',codex:'Codex',groq:'Groq'}[state.provider] || '클로'}${state.fallback ? ' · 자동 전환' : '와 대화'}`
  if (state.fallback) limitUntil = 0
}
window.pet.onChatProvider?.(showProvider)

function contentReady(ready) { document.body.classList.toggle('ready', ready) }

/** 꼬리를 펫 머리 쪽으로: originX는 창 기준, --tail-x는 말풍선 상자 기준. */
function placeTail() {
  const width = dialog.offsetWidth || Math.min(layout.width - 44, 340)
  const left = (layout.width - width) / 2
  const x = Math.min(Math.max(layout.originX - left, TAIL_EDGE_PX), width - TAIL_EDGE_PX)
  dialog.style?.setProperty('--tail-x', `${Math.round(x)}px`)
}
function applyLayout(next) {
  layout = { ...layout, ...next }
  document.body.classList.toggle('below', layout.side === 'below')
  placeTail()
}
function setPhase(next) {
  phase = next
  clearTimeout(phaseTimer)
  phaseTimer = null
  document.body.classList.toggle('shown', next !== 'closed')
  dialog.classList.toggle('opening', next === 'opening')
  dialog.classList.toggle('closing', next === 'closing')
}
function finishOpen() {
  setPhase('open')
  contentReady(true)
  if (shown) input.focus({ preventScroll: true })
}
function finishClose() {
  setPhase('closed')
  contentReady(false)
  window.pet.bubbleClosed?.()
}
function animate(target, immediate = false) {
  if (target === 1) {
    if (phase === 'open' || phase === 'opening') return
    // 숨겨진 창(처음 만들어진 직후)에서는 보이기 시작할 때 애니메이션을 시작한다.
    if (!shown && !immediate) return
    placeTail()
    if (immediate || cfg.reduceMotion) return finishOpen()
    setPhase('opening')
    void dialog.offsetWidth // 같은 클래스를 다시 붙여도 처음부터 재생되게
    phaseTimer = setTimeout(finishOpen, OPEN_MS)
    return
  }
  if (phase === 'closed' || phase === 'closing') return
  contentReady(false)
  if (immediate || cfg.reduceMotion || !shown) return finishClose()
  setPhase('closing')
  phaseTimer = setTimeout(finishClose, CLOSE_MS)
}
function scheduleClose() {
  clearTimeout(autoTimer)
  autoTimer = null
  if (!open || !shown || busy || input.value || cfg.bubbleSeconds <= 0) return
  const remaining = lastTouch + cfg.bubbleSeconds * 1000 - Date.now()
  if (remaining <= 0) requestClose()
  else autoTimer = setTimeout(requestClose, Math.min(2147483647, remaining))
}
function touch() { lastTouch = Date.now(); if (!busy) scheduleClose() }
function requestClose() { if (open) window.pet.expand(false) }
function clearPendingText() {
  if (reveal.frame !== null) cancelAnimationFrame(reveal.frame)
  reveal.frame = null
}
/** 바로 보여 준다(안내, 오류). 소리는 내지 않는다. */
function showText(text, hint = false) {
  clearPendingText()
  reveal.chars = Array.from(text)
  reveal.count = reveal.chars.length
  answer.classList.toggle('hint', hint)
  answer.textContent = text
  answer.scrollTop = answer.scrollHeight
}
/** 대답은 한 글자씩 나타나고, 글자마다 말소리가 난다(빠르게 이어지면 소리가 겹친다). */
function revealTo(text) {
  const chars = Array.from(text)
  // 앞서 보인 글자가 새 글자의 앞부분이 아니면(다른 서비스로 넘어가 새로 시작) 처음부터.
  const prefix = reveal.chars.slice(0, reveal.count)
  if (prefix.length > chars.length || prefix.some((c, i) => chars[i] !== c)) reveal.count = 0
  reveal.chars = chars
  answer.classList.remove('hint')
  if (!shown) return finishReveal()
  if (reveal.count === 0) answer.textContent = '' // 기다리는 점(…)을 걷어 낸다
  if (reveal.frame === null) {
    reveal.last = performance.now()
    reveal.carry = 0
    reveal.frame = requestAnimationFrame(stepReveal)
  }
}
function stepReveal(at) {
  reveal.frame = null
  const backlog = reveal.chars.length - reveal.count
  if (backlog <= 0) return
  reveal.carry += ((at - reveal.last) / 1000) * Math.max(REVEAL_CPS, backlog / 1.5)
  reveal.last = at
  const n = Math.min(backlog, Math.floor(reveal.carry))
  if (n > 0) {
    reveal.carry -= n
    const added = reveal.chars.slice(reveal.count, reveal.count + n)
    reveal.count += n
    answer.textContent = reveal.chars.slice(0, reveal.count).join('')
    answer.scrollTop = answer.scrollHeight
    if (added.some(c => /\S/.test(c))) sound.talk()
  }
  reveal.frame = requestAnimationFrame(stepReveal)
}
function finishReveal() {
  clearPendingText()
  reveal.count = reveal.chars.length
  answer.textContent = reveal.chars.join('')
  answer.scrollTop = answer.scrollHeight
}
function setBusy(next) {
  busy = next
  if (!busy) lastTouch = Date.now()
  send.disabled = busy
  cancel.hidden = !busy
  scheduleClose()
}
function waiting() {
  clearPendingText()
  reveal.chars = []
  reveal.count = 0
  answer.classList.remove('hint')
  answer.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
}
function visibility(state) {
  if (state.layout) applyLayout(state.layout)
  const wasOpen = open
  open = !!state.open
  shown = document.visibilityState !== 'hidden'
  document.body.classList.toggle('is-hidden', !shown)
  if (open && !wasOpen) {
    lastTouch = Date.now()
    if (!answer.hasChildNodes()) showText(HINT, true)
    sound.play('chatOpen')
  } else if (!open && wasOpen) sound.play('chatClose')
  animate(open ? 1 : 0, !!state.immediate)
  scheduleClose()
}

form.addEventListener('submit', event => {
  event.preventDefault()
  const question = input.value.trim()
  if (!question || busy || cfg.chatEnabled === false || event.isComposing) return
  if (Date.now() < limitUntil && !(cfg.chatChain?.length > 1)) {
    const time = new Date(limitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    showText(`zzz… 사용 제한에 걸려서 ${time}까지 쉬는 중이야.`)
    return
  }
  input.value = ''
  setBusy(true)
  waiting()
  touch()
  replied = false
  sound.play('chatEnter')
  window.pet.ask(question)
})
input.addEventListener('input', touch)
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.isComposing) event.preventDefault()
})
close.addEventListener('click', requestClose)
cancel.addEventListener('click', () => {
  window.pet.cancel()
  setBusy(false)
  showText('잠깐 쉬었다가 다시 이야기하자.')
  touch()
})
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') requestClose()
})
window.pet.onChatVisibility?.(visibility)
window.pet.onChatLayout?.(applyLayout)
window.pet.onChatStarted?.(() => { setBusy(true); waiting() })
window.pet.onChatCancelled?.(() => {
  if (!busy) return
  setBusy(false)
  showText('잠깐 쉬었다가 다시 이야기하자.')
  touch()
})
/** 대답 글자가 처음 나타나는 순간 한 번 소리를 낸다. */
function markReplied() {
  if (replied) return
  replied = true
  sound.play('chatResult')
}
window.pet.onDelta(text => {
  if (!busy) return
  if (!text) { waiting(); return } // 다른 서비스로 넘어가며 앞의 대답을 버렸다
  markReplied()
  revealTo(text)
  touch()
})
window.pet.onDone(text => {
  markReplied() // 글자가 흘러나오지 않고 한 번에 와도 한 번은 울린다
  revealTo(text)
  setBusy(false)
  touch()
})
window.pet.onError(message => {
  showText(`앗, 문제가 생겼어: ${message}`)
  setBusy(false)
  touch()
})
window.pet.onRateLimit(info => {
  if (info?.status === 'rejected' && Number(info.resetsAt) > 0) limitUntil = Number(info.resetsAt) * 1000
})
window.pet.onCleared(() => {
  setBusy(false)
  limitUntil = 0
  showText(HINT, true)
  touch()
})
function configure(next) {
  if (next.chatChain?.length > 1) limitUntil = 0
  if (!providerState || cfg.chatProvider !== next.chatProvider) showProvider({provider:next.chatProvider || 'claude'})
  cfg = next
  sound.configure(cfg)
  document.body.classList.toggle('reduce-motion', cfg.reduceMotion)
  if (cfg.reduceMotion && phase === 'opening') finishOpen()
  if (cfg.reduceMotion && phase === 'closing') finishClose()
  if (cfg.chatEnabled === false && open) requestClose()
  scheduleClose()
}
window.pet.onCfg(configure)
document.addEventListener('visibilitychange', () => {
  shown = document.visibilityState !== 'hidden'
  document.body.classList.toggle('is-hidden', !shown)
  sound.setVisible(shown)
  if (!shown) {
    // 숨겨지면 애니메이션 중간 단계는 바로 끝맺는다(숨은 창에서 타이머를 돌리지 않는다).
    if (phase === 'opening') finishOpen()
    if (phase === 'closing') finishClose()
    clearTimeout(autoTimer)
    autoTimer = null
    finishReveal()
    sound.stopTalk()
  } else {
    if (open) animate(1)
    scheduleClose()
  }
})
window.pet.init().then(init => {
  configure(init.cfg)
  if (init.chatVisibility) visibility(init.chatVisibility)
  else if (typeof init.chatOpen === 'boolean') visibility({ open: init.chatOpen, layout: init.chatLayout })
  else placeTail()
})
window.addEventListener('pagehide', () => {
  clearTimeout(phaseTimer)
  clearPendingText()
  clearTimeout(autoTimer)
})
