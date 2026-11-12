// The chat lives in its own fixed-size native window. Only SVG vertices change;
// neither this window nor the character window resizes during the morph.
const el = id => document.getElementById(id)
const shell = el('shell')
const shellPath = el('shellPath')
const answer = el('answer')
const form = el('ask')
const input = el('q')
const send = el('send')
const cancel = el('cancel')
const close = el('closeBubble')
const HINT = '안녕, 나 클로야! 뭐든 물어봐.'
const MORPH_MS = 260

let cfg = { bubbleSeconds: 30, reduceMotion: false, chatEnabled: true }
let layout = { width: 340, height: 224, originX: 170, originY: 222, side: 'above' }
let open = false
let shown = document.visibilityState !== 'hidden'
let busy = false
let progress = 0
let morph = null
let morphFrame = null
let textFrame = null
let pendingText = null
let autoTimer = null
let lastTouch = Date.now()
let limitUntil = 0

function paint() {
  shellPath.setAttribute('d', window.BubbleShape.path(window.BubbleShape.points(progress, layout)))
}
function contentReady(ready) { document.body.classList.toggle('ready', ready) }
function stopMorph() {
  if (morphFrame !== null) cancelAnimationFrame(morphFrame)
  morphFrame = null
  morph = null
}
function finishMorph(target) {
  progress = target
  stopMorph()
  paint()
  contentReady(open && target === 1)
  if (open && target === 1 && shown) input.focus({ preventScroll: true })
  if (!open && target === 0) window.pet.bubbleClosed?.()
}
function animate(target, immediate = false) {
  stopMorph()
  contentReady(false)
  if (!shown && target === 1 && !immediate) {
    paint() // A lazy-created native window is still hidden until main shows it.
    return
  }
  if (immediate || cfg.reduceMotion || !shown || Math.abs(target - progress) < 0.0001) {
    finishMorph(target)
    return
  }
  morph = { from: progress, to: target, at: performance.now(), duration: MORPH_MS * Math.abs(target - progress) }
  const tick = at => {
    morphFrame = null
    if (!morph || !shown) return
    const t = Math.min(1, Math.max(0, (at - morph.at) / morph.duration))
    const eased = 1 - Math.pow(1 - t, 3)
    progress = morph.from + (morph.to - morph.from) * eased
    paint()
    if (t >= 1) finishMorph(morph.to)
    else morphFrame = requestAnimationFrame(tick)
  }
  morphFrame = requestAnimationFrame(tick)
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
  if (textFrame !== null) cancelAnimationFrame(textFrame)
  textFrame = null
  pendingText = null
}
function showText(text, hint = false) {
  clearPendingText()
  answer.classList.toggle('hint', hint)
  answer.textContent = text
  answer.scrollTop = answer.scrollHeight
}
function queueText(text) {
  pendingText = text
  if (!shown || textFrame !== null) return
  textFrame = requestAnimationFrame(() => {
    textFrame = null
    if (pendingText !== null) showText(pendingText)
  })
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
  answer.classList.remove('hint')
  answer.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
}
function visibility(state) {
  if (state.layout) {
    layout = { ...layout, ...state.layout }
    shell.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`)
    document.body.classList.toggle('below', layout.side === 'below')
  }
  const wasOpen = open
  open = !!state.open
  shown = document.visibilityState !== 'hidden'
  document.body.classList.toggle('is-hidden', !shown)
  if (open && !wasOpen) {
    lastTouch = Date.now()
    if (!answer.hasChildNodes()) showText(HINT, true)
  }
  animate(open ? 1 : 0, !!state.immediate)
  scheduleClose()
}

form.addEventListener('submit', event => {
  event.preventDefault()
  const question = input.value.trim()
  if (!question || busy || cfg.chatEnabled === false || event.isComposing) return
  if (Date.now() < limitUntil) {
    const time = new Date(limitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    showText(`zzz… 사용 제한에 걸려서 ${time}까지 쉬는 중이야.`)
    return
  }
  input.value = ''
  setBusy(true)
  waiting()
  touch()
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
window.pet.onChatLayout?.(next => {
  layout = { ...layout, ...next }
  shell.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`)
  document.body.classList.toggle('below', layout.side === 'below')
  paint()
})
window.pet.onChatStarted?.(() => { setBusy(true); waiting() })
window.pet.onChatCancelled?.(() => {
  if (!busy) return
  setBusy(false)
  showText('잠깐 쉬었다가 다시 이야기하자.')
  touch()
})
window.pet.onDelta(text => { if (busy) { queueText(text); touch() } })
window.pet.onDone(text => {
  showText(text)
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
  cfg = next
  document.body.classList.toggle('reduce-motion', cfg.reduceMotion)
  if (cfg.reduceMotion && morph) finishMorph(open ? 1 : 0)
  if (cfg.chatEnabled === false && open) requestClose()
  scheduleClose()
}
window.pet.onCfg(configure)
document.addEventListener('visibilitychange', () => {
  shown = document.visibilityState !== 'hidden'
  document.body.classList.toggle('is-hidden', !shown)
  if (!shown) {
    stopMorph()
    clearTimeout(autoTimer)
    autoTimer = null
    if (textFrame !== null) cancelAnimationFrame(textFrame)
    textFrame = null
  } else {
    if (pendingText !== null) showText(pendingText)
    if (open) animate(1)
    scheduleClose()
  }
})
window.pet.init().then(init => {
  configure(init.cfg)
  if (init.chatVisibility) visibility(init.chatVisibility)
  else if (typeof init.chatOpen === 'boolean') visibility({ open: init.chatOpen, layout: init.chatLayout })
  else paint()
})
window.addEventListener('pagehide', () => {
  stopMorph()
  clearPendingText()
  clearTimeout(autoTimer)
})
