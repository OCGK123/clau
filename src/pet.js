// 펫 화면: 레이어를 겹쳐 그리고, 상태에 따라 눈·입·몸을 움직이고, 말풍선으로 대화한다.
const el = id => document.getElementById(id)
const stage = el('stage')
const petEl = el('pet')
const bodyEl = el('body')
const buddyEl = el('buddy')
const bubble = el('bubble')
const answer = el('answer')
const form = el('ask')
const input = el('q')
const sendBtn = el('send')
const cancelBtn = el('cancel')
const closeBtn = el('closeBubble')
const sound = window.ClauSound.create() // 쓰다듬기, Claude Code를 따라 말할 때, 대답을 마치고 신날 때
const moverEl = el('mover')
const spinner = el('spinner')

const HEADROOM = 0.06 // 폴짝 뛸 때 잘리지 않게 위쪽에 두는 여백
const HAPPY_MS = 2500
const OOPS_MS = 3000
const PLEASED_MS = 1200
const PET_LINGER_MS = 650 // 손을 뗀 뒤에도 이만큼은 쓰다듬는 표정으로
const STALE_MS = 10 * 60_000 // Claude Code 쪽 상태가 이보다 오래되면 믿지 않는다
const DRAG_START_PX = 4
const PAT_COMBO_MS = 600 // 이 안에 또 누르면 연타로 친다
const MAX_HEARTS = 8
const HINT = '안녕! 난 클로야. 만나서 반가워!!!!!!'
const HEART = '<svg viewBox="0 0 20 18"><path d="M10 16.6C4.2 12.3 1.2 9.5 1.2 6a4.5 4.5 0 0 1 8.8-1.4A4.5 4.5 0 0 1 18.8 6c0 3.5-3 6.3-8.8 10.6z"/></svg>'

// 그리는 순서: 작은 친구 → 몸 → 눈 → 입 → 앞머리
const BODY_ROLES = ['base', 'eyes_open', 'eyes_closed', 'eyes_happy', 'eyes_x', 'eyes_petted', 'mouth_closed', 'mouth_open', 'mouth_sleep', 'hair']

let cfg
let layers
let bust = 0.69
let mode = 'idle'
let scale = 1 // 그림 좌표 → 화면 px
let visible = true
let mainVisible = true
let geometry = null
let stateTimer = null
let pausedAnimations = []
const imgs = {}

const rand = (lo, hi) => lo + Math.random() * (hi - lo)

// ── 그리기 ─────────────────────────────────────────────────────────────
function viewRect() {
  return cfg.showBuddy || !layers.layers.base ? layers.view : layers.layers.base
}

function build() {
  const make = (role, parent, cls) => {
    const layerRole = role === 'eyes_petted' ? 'eyes_x' : role
    if (!layers.layers[layerRole]) return
    if (role === 'eyes_open') return makeEyes(parent, cls)
    const img = document.createElement('img')
    img.dataset.role = role
    img.className = cls
    img.src = `../assets/${layerRole}.png`
    img.draggable = false
    parent.appendChild(img)
    imgs[role] = img
  }
  make('buddy', buddyEl, '')
  for (const role of BODY_ROLES) make(role, bodyEl, role.startsWith('eyes') ? 'eyes' : role.startsWith('mouth') ? 'mouth' : '')
  window.PetAnimator.attach(moverEl, imgs.buddy ?? null)
  window.PetFx.attach(el('fx'))
}

/**
 * 뜬 눈은 세 장을 겹친다: 흰자, 눈동자(눈 모양 안에서만 보임), 눈꺼풀 선.
 * 마우스 따라보기는 눈동자만 움직인다. 깜빡임은 이 묶음 전체를 누른다.
 */
function makeEyes(parent, cls) {
  const stack = document.createElement('div')
  stack.dataset.role = 'eyes_open'
  stack.className = `${cls} eye-stack`
  const layer = (name, into, className) => {
    const img = document.createElement('img')
    img.src = `../assets/${name}.png`
    img.draggable = false
    img.className = className
    into.appendChild(img)
    return img
  }
  layer('eyes_white', stack, 'eye-white')
  const clip = document.createElement('div')
  clip.className = 'eye-clip'
  stack.appendChild(clip)
  layer('eyes_iris', clip, 'eye-iris')
  layer('eyes_lid', stack, 'eye-lid')
  parent.appendChild(stack)
  imgs.eyes_open = stack
}

/** 지금 그릴 모양. 메인이 정해 보내 준다(자동 모드는 바닥에 앉았는지에 따라 바뀐다). */
function currentShape() {
  const [, , vw, vh] = viewRect()
  const given = geometry?.shape
  if (given) return given
  const shownH = cfg.view === 'bust' ? vh * bust : vh
  return { width: Math.max(40, Math.round((cfg.size * vw) / shownH)), height: cfg.size, unit: cfg.size, view: cfg.view === 'bust' ? 'bust' : 'full', auto: false }
}

function layout() {
  const [vx, vy, vw, vh] = viewRect()
  const shape = currentShape()
  const petH = shape.height
  const petW = shape.width
  // 자동 모드는 전신·상반신이 같은 크기로 그려지고, 아래쪽만 바닥에 가려진다.
  const shownH = shape.auto || shape.view !== 'bust' ? vh : vh * bust
  scale = (shape.unit * (1 - HEADROOM)) / shownH
  const s = scale
  const unit = shape.unit

  stage.style.width = `${petW}px`
  stage.style.height = `${petH}px`
  stage.style.opacity = String(cfg.opacity / 100)
  petEl.style.width = `${vw * s}px`
  petEl.style.height = `${vh * s}px`
  petEl.style.left = `${(petW - vw * s) / 2}px`
  petEl.style.top = `${unit * HEADROOM}px`
  petEl.style.setProperty('--u', `${unit / 100}px`)
  stage.style.setProperty('--u', `${unit / 100}px`)
  petEl.classList.toggle('no-buddy', !cfg.showBuddy)
  petEl.classList.toggle('flip', cfg.flip)
  petEl.classList.toggle('calm', cfg.reduceMotion)
  stage.classList.toggle('chat-enabled', cfg.chatEnabled !== false)
  stage.classList.toggle('drag-disabled', cfg.dragEnabled === false)
  document.body.classList.toggle('reduce-motion', cfg.reduceMotion)
  window.PetAnimator.setUnit(unit / 100)
  window.PetAnimator.setCalm(cfg.reduceMotion)
  window.PetFx.setOff(cfg.reduceMotion)
  applyWindowLayout(geometry)

  const put = (node, [x, y, w, h]) => {
    node.style.left = `${(x - vx) * s}px`
    node.style.top = `${(y - vy) * s}px`
    node.style.width = `${w * s}px`
    node.style.height = `${h * s}px`
  }
  for (const role of BODY_ROLES) {
    if (imgs[role]) put(imgs[role], layers.layers[role === 'eyes_petted' ? 'eyes_x' : role])
  }
  // 작은 친구는 둥실거리는 상자째로 자리를 잡는다.
  if (layers.layers.buddy) put(buddyEl, layers.layers.buddy)

  // 마우스 따라보기: 두 눈 한가운데(stage 기준)와 움직일 수 있는 폭.
  const eyes = layers.layers.eyes_open
  if (eyes) {
    const local = (eyes[0] - vx + eyes[2] / 2) * s
    eyeAim = {
      x: (petW - vw * s) / 2 + (cfg.flip ? vw * s - local : local),
      y: unit * HEADROOM + (eyes[1] - vy + eyes[3] / 2) * s,
      // 눈동자가 흰자 안에 머무는 폭(그림 픽셀 기준: 옆으로 10, 위아래로 5).
      reachX: 10 * s,
      reachY: 5 * s,
    }
  }
  aimEyes()

  // z는 머리 오른쪽 위에서 떠오른다.
  const [bx, by, bw, bh] = layers.layers.base ?? layers.view
  for (const z of petEl.querySelectorAll('.z')) {
    z.style.left = `${(bx - vx + bw * 0.78) * s}px`
    z.style.top = `${(by - vy + bh * 0.12) * s}px`
  }
}

// ── 마우스 따라보기 ───────────────────────────────────────────────────
let eyeAim = null // 눈 가운데와 움직일 수 있는 폭
let look = null // 펫 창 기준 마우스 자리
function aimEyes() {
  const s = geometry?.stage
  // 눈동자가 보일 때만 따라본다(감은 눈, X 눈, 웃는 눈일 때는 쉰다).
  if (petEl.dataset.eyes !== 'open') return
  if (!look || !eyeAim || !s || !cfg?.lookAtCursor || cfg.reduceMotion) {
    petEl.style.setProperty('--look-x', '0px')
    petEl.style.setProperty('--look-y', '0px')
    return
  }
  const dx = look.x - (s.left + eyeAim.x)
  const dy = look.y - (s.top + eyeAim.y)
  const distance = Math.hypot(dx, dy) || 1
  // 가까우면 조금, 멀어질수록 끝까지. 화면 반대편을 봐도 눈이 얼굴 밖으로 나가지 않는다.
  const reach = Math.tanh(distance / (eyeAim.reachX * 30))
  let x = (dx / distance) * reach * eyeAim.reachX
  const y = (dy / distance) * reach * eyeAim.reachY
  if (cfg.flip) x = -x // 뒤집힌 그림 안에서는 좌우가 반대
  petEl.style.setProperty('--look-x', `${x.toFixed(2)}px`)
  petEl.style.setProperty('--look-y', `${y.toFixed(2)}px`)
}
// 배터리로 돌 때는 가만히 있는 동안의 숨쉬기를 쉰다.
window.pet.onPower?.(state => window.PetAnimator.setIdleMotion(!state?.battery))

window.pet.onLook?.(point => {
  look = point
  aimEyes()
})
// 눈을 다시 뜨면 지금 마우스 쪽부터 본다.
if (typeof MutationObserver === 'function') {
  new MutationObserver(() => { if (petEl.dataset.eyes === 'open') aimEyes() }).observe(petEl, { attributes: true, attributeFilter: ['data-eyes'] })
}

/** Main owns screen coordinates. These responsive offsets also hold the same
 * screen anchor during a native window resize, before the next IPC arrives. */
function applyWindowLayout(next) {
  if (!next) return
  const reshaped = JSON.stringify(next.shape) !== JSON.stringify(geometry?.shape)
  geometry = next
  const s = next.stage
  if (s) {
    stage.style.left = Number.isFinite(s.anchorX) ? `calc((100% - ${s.width}px) * ${s.anchorX})` : `${s.left}px`
    stage.style.top = Number.isFinite(s.anchorY) ? `calc((100% - ${s.height}px) * ${s.anchorY})` : `${s.top}px`
    // 바닥(화면이나 앱 창의 아래 끝) 아래는 그리지 않는다. 옆과 위는 흔들릴 자리를 남긴다.
    stage.style.clipPath = Number.isFinite(s.cut) ? `polygon(-4000px -4000px, 4000px -4000px, 4000px ${s.cut}px, -4000px ${s.cut}px)` : ''
  }
  if (reshaped && layers && cfg) layout()
  else aimEyes()
}

/** 쓰다듬는 영역(화면 px, stage 기준): 그림 꼭대기부터 눈 바로 위까지. 얼굴과 몸은 말 거는 자리다. */
function headZone() {
  const L = layers.layers
  const [vx, vy] = viewRect()
  const [bx, by, bw, bh] = L.base ?? layers.view
  const eyes = L.eyes_open ?? L.eyes_closed
  // 눈 정보가 없으면 그림 위쪽 4분의 1을 머리로 본다.
  const brow = eyes ? eyes[1] : by + bh * 0.25
  // 좌우는 눈을 중심으로 넉넉하게.
  const cx = eyes ? eyes[0] + eyes[2] / 2 : bx + bw / 2
  const half = eyes ? eyes[2] * 0.95 : bw / 2
  const ox = parseFloat(petEl.style.left) || 0
  const oy = parseFloat(petEl.style.top) || 0
  const left = ox + (cx - half - vx) * scale
  const width = half * 2 * scale
  return {
    left: cfg.flip ? stage.clientWidth - left - width : left,
    top: oy + (by - vy) * scale,
    width,
    height: (brow - by) * scale,
  }
}

/** 창 기준 머리 한가운데: 반짝이를 띄울 자리. */
function headPoint() {
  const z = headZone()
  return { x: stage.offsetLeft + z.left + z.width / 2, y: stage.offsetTop + z.top + z.height * 0.3 }
}
function fxAtHead(kind, count, spread) {
  if (!layers || !visible) return
  const p = headPoint()
  window.PetFx.burst(p.x, p.y, kind, count, spread)
}

// ── 생각 중 로딩 표시 ──────────────────────────────────────────────────
// 캐릭터 창은 회전 여유만큼 커서 머리 위에 자리가 있다. 창 위쪽 끝을 넘지는 않게 한다.
const SPINNER_OUT_MS = 180 // pet.css spinner-out 길이와 맞춘다
const SPINNER_TOP_PX = 3 // 창 위쪽 끝에 붙어 살이 잘리지 않게
let spinnerTimer = null
function placeSpinner() {
  const z = headZone()
  const size = spinner.offsetWidth || 46
  let x
  let y
  if (bubbleOpen) {
    // 말풍선이 머리 위를 덮으므로, 열려 있을 땐 머리 옆(작은 친구 반대쪽)에 띄운다.
    const right = !cfg.flip
    x = stage.offsetLeft + (right ? z.left + z.width + 6 : z.left - size - 6)
    y = stage.offsetTop + z.top + z.height * 0.2
  } else {
    // 창이 회전 여유만큼 커서 머리 위에 자리가 있다. 모자 꼭대기 바로 위에 띄운다.
    x = stage.offsetLeft + z.left + z.width / 2 - size / 2
    y = Math.max(SPINNER_TOP_PX, stage.offsetTop + z.top - size - 4)
  }
  spinner.style.translate = `${Math.round(x - stage.offsetLeft)}px ${Math.round(y - stage.offsetTop)}px`
}
function showSpinner(on) {
  if (!layers) return
  clearTimeout(spinnerTimer)
  if (on) {
    spinner.classList.remove('leaving')
    if (spinner.hidden) {
      spinner.hidden = false
      placeSpinner()
    }
  } else if (!spinner.hidden && !spinner.classList.contains('leaving')) {
    spinner.classList.add('leaving')
    spinnerTimer = setTimeout(() => {
      spinner.hidden = true
      spinner.classList.remove('leaving')
    }, SPINNER_OUT_MS)
  }
}

function onHead(e) {
  if (!cfg.petting) return false
  const box = stage.getBoundingClientRect()
  const x = e.clientX - box.left
  const y = e.clientY - box.top
  const z = headZone()
  return x >= z.left && x <= z.left + z.width && y >= z.top && y <= z.top + z.height
}

// ── 눈·입 애니메이션 ───────────────────────────────────────────────────
const EYE_ROLE = { open: 'eyes_open', closed: 'eyes_closed', happy: 'eyes_happy', x: 'eyes_x', petted: 'eyes_petted' }
let blinkTimer = null
let flapTimer = null

/** 그림 한 장을 잠깐 움직인다. 하던 움직임은 끊고 새로 시작한다. */
function play(node, frames, duration, easing = 'ease-out') {
  if (!node || cfg.reduceMotion || !visible) return
  for (const running of node.getAnimations()) if (running.id === 'pop') running.cancel()
  node.animate(frames, { duration, easing, id: 'pop' })
}

function setMode(next) {
  if (next === mode) return
  mode = next
  petEl.className = petEl.className.replace(/\bmode-\S+/g, '').trim() + ` mode-${mode}`
  window.PetAnimator.setMode(mode)
  if (mode === 'happy') fxAtHead('sparkle', 6, 1.8)
  showSpinner(mode === 'thinking')
  applyFace()
}

function applyFace() {
  if (!cfg || !layers) return
  clearTimeout(blinkTimer)
  clearTimeout(flapTimer)
  clearBlinkFx()
  const eyes = { held: 'x', thinking: 'closed', sleeping: 'closed', dozing: 'closed', happy: 'happy', pleased: 'happy', oops: 'x', petted: 'petted' }[mode] ?? 'open'
  const mouth = { sleeping: 'sleep', oops: 'sleep' }[mode] ?? 'closed'
  const changed = petEl.dataset.eyes !== eyes
  petEl.dataset.eyes = eyes
  petEl.dataset.mouth = mouth
  // 표정이 바뀌는 순간 눈이 한 번 통 튄다.
  if (changed) {
    play(imgs[EYE_ROLE[eyes]], [{ transform: 'scale(0.9, 0.62)' }, { transform: 'scale(1.05, 1.12)', offset: 0.55 }, { transform: 'scale(1, 1)' }], 240)
  }
  if (visible && eyes === 'open') scheduleBlink()
  if (visible && mode === 'talking') flap(false)
}

/** 몇 초에 한 번 깜빡, 가끔은 두 번 연속. */
function scheduleBlink() {
  blinkTimer = setTimeout(() => blink(Math.random() < 0.25 ? 2 : 1), rand(1800, 5000))
}
const BLINK_CLOSE_MS = 70 // pet.css lid-close 길이와 맞춘다
const BLINK_OPEN_MS = 130 // pet.css lid-open 길이와 맞춘다
function clearBlinkFx() {
  petEl.classList.remove('lid-closing', 'lid-opening')
}
/** 같은 클래스를 다시 붙여도 애니메이션이 처음부터 돌도록 스타일을 한 번 확정시킨다. */
function restartFx(cls) {
  clearBlinkFx()
  void petEl.offsetWidth
  petEl.classList.add(cls)
}
/**
 * 눈꺼풀이 위에서 빠르게 내려와 덮고(감기), 조금 느리게 걷힌다(뜨기).
 * 눈 그림 자체는 찌그러뜨리지 않는다: 부풀어 보이거나 몸 전체가 움찔해 보이던 원인이었다.
 */
function blink(times) {
  if (!visible) return
  if (cfg.reduceMotion) {
    petEl.dataset.eyes = 'closed'
    blinkTimer = setTimeout(() => {
      petEl.dataset.eyes = 'open'
      if (times > 1) blinkTimer = setTimeout(() => blink(times - 1), rand(120, 200))
      else scheduleBlink()
    }, rand(100, 160))
    return
  }
  restartFx('lid-closing')
  blinkTimer = setTimeout(() => {
    clearBlinkFx()
    petEl.dataset.eyes = 'closed'
    blinkTimer = setTimeout(() => {
      petEl.dataset.eyes = 'open'
      restartFx('lid-opening')
      blinkTimer = setTimeout(() => {
        clearBlinkFx()
        if (times > 1) blinkTimer = setTimeout(() => blink(times - 1), rand(60, 110))
        else scheduleBlink()
      }, BLINK_OPEN_MS)
    }, rand(35, 60))
  }, BLINK_CLOSE_MS)
}

/** 말하는 동안: 입이 랜덤한 간격으로 열렸다 닫히고, 가끔 단어 사이처럼 잠깐 쉰다. */
function flap(open) {
  if (!visible) return
  open = Math.random() < 0.8 ? !open : open
  petEl.dataset.mouth = open ? 'open' : 'closed'
  if (open) play(imgs.mouth_open, [{ transform: 'scale(0.82, 0.55)' }, { transform: 'scale(1, 1)' }], 80)
  // 말풍선 대답은 글자마다 말풍선이 소리를 낸다. 여기서는 Claude Code를 따라 말할 때만.
  if (open && !bubbleOpen && local !== 'talking') sound.talk()
  let ms = open ? rand(90, 260) : rand(70, 220)
  if (!open && Math.random() < 0.1) ms = rand(350, 700)
  flapTimer = setTimeout(() => flap(open), ms)
}

// ── 어떤 상태를 보여 줄지 ──────────────────────────────────────────────
let local = null // 펫과 직접 대화 중일 때의 상태
let localUntil = 0
let localAfter = null
let cc = null // Claude Code 쪽 mod가 알려 준 상태
let limitUntil = 0 // 사용 제한이 풀리는 시각(ms)
let dozing = false
let idleSince = Date.now()
let touched = null // 쓰다듬는 중이면 'petted', 손을 뗀 직후면 'pleased'
let touchUntil = 0

function setLocal(next, ms, after = null) {
  local = next
  localUntil = next && ms ? Date.now() + ms : 0
  localAfter = after
  recompute()
}

function claudeDeadline() {
  if (!cc || !cfg.followClaudeCode) return 0
  const at = Number(cc.at) || 0
  if (cc.mode === 'sleeping') return cc.resetsAt ? Date.parse(cc.resetsAt) : at + 6 * 3600_000
  const duration = { happy: HAPPY_MS, oops: OOPS_MS, thinking: STALE_MS, talking: STALE_MS, working: STALE_MS }[cc.mode]
  return duration ? at + duration : 0
}

function expireStates(now) {
  let expiredAt = 0
  if (localUntil && now >= localUntil) {
    expiredAt = localUntil
    local = localAfter
    localAfter = null
    localUntil = local === 'happy' ? expiredAt + HAPPY_MS : 0
    if (localUntil && now >= localUntil) {
      expiredAt = localUntil
      local = null
      localUntil = 0
    }
  }
  if (touchUntil && now >= touchUntil) {
    expiredAt = Math.max(expiredAt, touchUntil)
    if (touched === 'petted') {
      touched = 'pleased'
      touchUntil += PLEASED_MS
    } else {
      touched = null
      touchUntil = 0
    }
    if (touchUntil && now >= touchUntil) {
      expiredAt = Math.max(expiredAt, touchUntil)
      touched = null
      touchUntil = 0
    }
  }
  return expiredAt
}

/** One timeout for the next actual state transition; idle does no polling. */
function scheduleStateUpdate() {
  clearTimeout(stateTimer)
  stateTimer = null
  if (!visible || !cfg) return
  const now = Date.now()
  const deadlines = [localUntil, touchUntil, limitUntil, claudeDeadline()]
  if (mode === 'idle' && cfg.dozeMinutes > 0) deadlines.push(idleSince + cfg.dozeMinutes * 60_000)
  const next = deadlines.filter(at => Number.isFinite(at) && at > now).sort((a, b) => a - b)[0]
  if (next) stateTimer = setTimeout(recompute, Math.min(2147483647, Math.max(1, next - now)))
}

function claudeCodeMode() {
  if (!cc || !cfg.followClaudeCode || typeof cc.mode !== 'string') return null
  const age = Date.now() - (Number(cc.at) || 0)
  switch (cc.mode) {
    case 'sleeping': {
      const until = cc.resetsAt ? Date.parse(cc.resetsAt) : (Number(cc.at) || 0) + 6 * 3600_000
      return until > Date.now() ? 'sleeping' : 'idle'
    }
    case 'happy':
      return age < HAPPY_MS ? 'happy' : 'idle'
    case 'oops':
      return age < OOPS_MS ? 'oops' : 'idle'
    case 'thinking':
    case 'talking':
    case 'working':
      return age < STALE_MS ? cc.mode : 'idle'
    default:
      return 'idle'
  }
}

function recompute() {
  if (!cfg) return
  const now = Date.now()
  const expiredAt = expireStates(now)
  // 쓰다듬기가 가장 먼저, 그다음 펫과의 대화, 사용 제한, Claude Code 순서.
  let next = (dragging ? 'held' : null) ?? touched ?? local ?? (Date.now() < limitUntil ? 'sleeping' : null) ?? claudeCodeMode() ?? 'idle'
  if (next === 'idle') {
    if (mode !== 'idle' && mode !== 'dozing') idleSince = Math.max(idleSince, expiredAt || Math.min(now, claudeDeadline() || now))
    if (cfg.dozeMinutes > 0 && now - idleSince >= cfg.dozeMinutes * 60_000) dozing = true
    if (dozing) next = 'dozing'
  } else {
    dozing = false
    idleSince = Date.now()
  }
  setMode(next)
  scheduleStateUpdate()
}

function wake() {
  dozing = false
  idleSince = Date.now()
  recompute()
}

// ── 쓰다듬기 ───────────────────────────────────────────────────────────
let pats = 0
let lastPat = 0
let lastRub = 0

function startPetting() {
  touchUntil = 0
  touched = 'petted'
  wake()
}

/** 한 번 톡: 누를 때마다 몸이 꾹 눌렸다 튀어 오르고, 연달아 누를수록 더 깊게 눌린다. */
function pat(e) {
  const now = performance.now()
  pats = now - lastPat < PAT_COMBO_MS ? pats + 1 : 1
  lastPat = now
  startPetting()
  window.PetAnimator.restart() // 연타할 때마다 말랑 동작이 처음부터 다시
  if (e) window.PetFx.burst(e.clientX, e.clientY, 'sparkle', 3, 0.8)
  sound.pat() // 연타하면 소리가 끊기지 않고 겹친다
  boing(0.055 + 0.05 * (Math.min(pats, 8) / 8))
  play(imgs.eyes_petted, [{ transform: 'scale(1.1, 0.72)' }, { transform: 'scale(0.96, 1.1)', offset: 0.5 }, { transform: 'scale(1, 1)' }], 260)
  heart()
}

function boing(depth) {
  if (cfg.reduceMotion || !visible) return
  for (const running of bodyEl.getAnimations()) if (running.id === 'boing') running.cancel()
  const at = (x, y) => ({ transform: `scale(${(1 + depth * x).toFixed(4)}, ${(1 + depth * y).toFixed(4)})` })
  bodyEl.animate(
    [at(0.4, -0.5), { ...at(0.85, -1), offset: 0.2 }, { ...at(-0.45, 0.6), offset: 0.48 }, { ...at(0.2, -0.24), offset: 0.74 }, at(0, 0)],
    { duration: 430, easing: 'ease-out', id: 'boing' },
  )
}

/** 머리 위로 작은 하트가 하나 떠오른다. */
function heart() {
  if (cfg.reduceMotion || !visible || stage.querySelectorAll('.heart').length >= MAX_HEARTS) return
  const zone = headZone()
  const node = document.createElement('i')
  node.className = 'heart'
  node.innerHTML = HEART
  node.style.left = `${zone.left + zone.width * rand(0.18, 0.82)}px`
  node.style.top = `${zone.top + zone.height * rand(0.3, 0.75)}px`
  node.style.setProperty('--drift', `${rand(-12, 12).toFixed(1)}px`)
  node.style.setProperty('--lean', `${rand(-20, 20).toFixed(0)}deg`)
  node.addEventListener('animationend', () => node.remove())
  stage.appendChild(node)
}

/** 손을 떼면 조금 더 말랑거리다가, 기분 좋은 얼굴로 한 번 출렁이고 돌아온다. */
function stopPetting(linger = PET_LINGER_MS) {
  if (touched !== 'petted') return
  if (linger <= 0) {
    touched = 'pleased'
    touchUntil = Date.now() + PLEASED_MS
    recompute()
    return
  }
  touchUntil = Date.now() + linger
  scheduleStateUpdate()
}

// ── 말풍선과 대화 ──────────────────────────────────────────────────────
let busy = false
let speechStartedAt = null
let lastTouch = Date.now()
let bubbleOpen = false
let happyTimer = null
const touch = () => { lastTouch = Date.now(); if (!busy) scheduleStateUpdate() }

function showHint() {
  answer.textContent = HINT
  answer.classList.add('hint')
}
function showAnswer(text) {
  answer.classList.remove('hint')
  answer.textContent = text
  answer.scrollTop = answer.scrollHeight
}
function showWaiting() {
  answer.classList.remove('hint')
  answer.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
}

function openBubble() {
  if (cfg.chatEnabled === false) return
  bubbleOpen = true
  if (!spinner.hidden) placeSpinner()
  window.pet.expand(true)
}
function closeBubble(immediate = false) {
  if (!bubbleOpen) return
  bubbleOpen = false
  sound.stop()
  window.pet.expand(false)
}

const limitTime = () => new Date(limitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

form.addEventListener('submit', e => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text || busy || cfg.chatEnabled === false || e.isComposing) return
  sound.unlock()
  if (Date.now() < limitUntil) {
    showAnswer(`zzz… 사용 제한에 걸려서 ${limitTime()}까지 쉬는 중이야.`)
    return
  }
  input.value = ''
  busy = true
  speechStartedAt = null
  sendBtn.disabled = true
  cancelBtn.hidden = false
  showWaiting()
  touch()
  setLocal('thinking')
  window.pet.ask(text)
})

function finish(stopAll = false) {
  clearTimeout(happyTimer)
  busy = false
  sendBtn.disabled = false
  cancelBtn.hidden = true
  if (stopAll) sound.stop()
  touch()
}

window.pet.onDelta(whole => {
  if (!busy) return
  if (!whole) { speechStartedAt = null; setLocal('thinking'); return }
  if (local !== 'talking') {
    speechStartedAt = performance.now()
    setLocal('talking')
  }
})
window.pet.onDone(text => {
  if (!busy) return
  showAnswer(text)
  finish()
  // Some providers deliver a single final event. Give that reply a visible,
  // audible speaking beat too, without delaying the user's next question.
  const spokenFor = speechStartedAt === null ? 0 : performance.now() - speechStartedAt
  const remaining = Math.max(0, Math.min(1500, Math.max(500, Array.from(text).length * 25)) - spokenFor)
  if (remaining > 0 && bubbleOpen && visible && cfg.chatEnabled !== false) {
    setLocal('talking', remaining, 'happy')
    happyTimer = setTimeout(() => sound.play('chatHappy'), remaining) // 말하기가 끝나고 ^^ 폴짝할 때
  } else {
    setLocal('happy', HAPPY_MS)
    sound.play('chatHappy')
  }
})
window.pet.onError(message => {
  if (!busy) return
  finish(true)
  if (Date.now() < limitUntil) {
    showAnswer(`zzz… 사용 제한에 걸렸어. ${limitTime()}에 다시 일어날게.`)
    setLocal(null)
  } else {
    showAnswer(`앗, 문제가 생겼어: ${message}`)
    setLocal('oops', OOPS_MS)
  }
})
window.pet.onChatProvider?.(info => {
  const provider = typeof info === 'string' ? info : info?.provider
  if (provider !== 'codex' && provider !== 'groq') return
  limitUntil = 0
  if (busy && info?.fallback) { speechStartedAt = null; setLocal('thinking') }
  else recompute()
})
window.pet.onRateLimit(info => {
  // 거절된 창이 있으면 그 리셋 시각까지 잔다(초 단위 epoch).
  if (info && info.status === 'rejected' && Number(info.resetsAt) > 0) limitUntil = Number(info.resetsAt) * 1000
  recompute()
})
window.pet.onCleared(() => {
  finish(true)
  limitUntil = 0
  setLocal(null)
  showHint()
})
cancelBtn.addEventListener('click', () => {
  window.pet.cancel()
  finish(true)
  setLocal(null)
  showAnswer('잠깐 쉬었다가 다시 이야기하자.')
})
closeBtn.addEventListener('click', closeBubble)
// Claude Code가 깨웠거나, 이미 떠 있는데 또 불렀을 때: 반갑게 한 번 폴짝.
window.pet.onHello(() => {
  wake()
  if (!local) setLocal('happy', HAPPY_MS)
})

// ── 고정 모드 ──────────────────────────────────────────────────────────
// 고정 모드에서는 자리를 옮길 수 없고 마우스도 그냥 통과한다.
// Claude 창이 앞에 있을 때 펫 위에 마우스를 올려 두면(armed) 우클릭을 받는다.
let locked = false
let armed = true

function onInput(state) {
  locked = !!state.locked
  armed = !!state.armed
  stage.classList.toggle('locked', locked)
  if (!cfg) return // 설정을 받기 전에 온 소식은 받아 두기만 한다
  stage.classList.toggle('can-chat', locked && cfg.lockedChat && cfg.chatEnabled !== false)
  if (locked && !cfg.lockedChat && bubbleOpen && !busy) closeBubble()
}
window.pet.onInput(onInput)

// ── 마우스: 머리는 쓰다듬기, 몸은 누르면 말풍선·끌면 이동, 오른쪽 클릭은 메뉴 ──
let down = null // { x, y, head }
let dragging = false
let pendulum = null
let heldFrame = null
let heldTick = null

// ── 내려놓기 ───────────────────────────────────────────────────────────
// 손을 떼면 기울어진 몸이 감쇠 진동으로 한두 번 살랑이며 똑바로 돌아오고, 동시에 몸이 착지하듯
// 한 번 눌렸다 펴진다(.mover). 예전엔 되돌리기(키프레임)와 출렁임(boing)이 따로 이어 붙어 어색했다.
// 창은 이제 크기가 바뀌지 않으므로 끌기는 놓는 즉시 끝낸다.
const SETTLE_DECAY_S = 0.17 // 흔들림이 잦아드는 빠르기(작을수록 빨리 멈춤)
const SETTLE_FREQ = 17 // 되돌아오며 살랑이는 빠르기(rad/s)
const SETTLE_MAX_MS = 900
const SWING_LIMIT_RAD = 0.6 // 자연스럽게: 약 34도
const SWING_SMOOTHING = 0.55 // 자연스럽게: 손 속도를 이만큼 부드럽게 따라간다
let heldAngle = 0
let settle = null // { frame } 되돌리는 중

/** -180~180도로: 여러 바퀴 돌았어도 가장 가까운 방향으로 돌아온다. */
const shortestAngle = deg => ((((deg % 360) + 540) % 360) - 180)

function finishSettle() {
  if (!settle) return
  if (settle.frame !== null) cancelAnimationFrame(settle.frame)
  settle = null
  bodyEl.style.removeProperty('transform')
  bodyEl.style.removeProperty('transform-origin')
}

function settleThenEndDrag(pointerUp) {
  const start = shortestAngle(heldAngle)
  const origin = bodyEl.style.transformOrigin
  heldAngle = 0
  stopHeldMotion()
  // 마지막 움직임을 먼저 보내고 놓는다: 놓은 자리가 손이 있던 자리와 같도록.
  if (moveFrame !== null) cancelAnimationFrame(moveFrame)
  moveFrame = null
  if (pendingMove) window.pet.drag('move', ...pendingMove)
  pendingMove = null
  window.pet.drag('end')
  if (pointerUp) window.PetAnimator.bounce(0.05) // 착지하듯 한 번 꾹
  if (cfg.reduceMotion || !visible || Math.abs(start) < 0.5) return
  bodyEl.style.transformOrigin = origin
  const at0 = performance.now()
  settle = { frame: null }
  const tick = at => {
    if (!settle) return
    const t = (at - at0) / 1000
    // 감쇠 진동: 놓은 각도에서 시작해(cos) 반대로 살짝 넘어갔다가 잦아든다.
    const angle = start * Math.exp(-t / SETTLE_DECAY_S) * Math.cos(SETTLE_FREQ * t)
    bodyEl.style.transform = `rotate(${angle.toFixed(3)}deg)`
    if ((Math.abs(angle) < 0.15 && t > 0.15) || at - at0 > SETTLE_MAX_MS) return finishSettle()
    settle.frame = requestAnimationFrame(tick)
  }
  settle.frame = requestAnimationFrame(tick)
}

function stopHeldMotion() {
  if (heldFrame !== null) cancelAnimationFrame(heldFrame)
  heldFrame = null
  heldTick = null
  pendulum?.stop()
  pendulum = null
  bodyEl.style.removeProperty('transform')
  bodyEl.style.removeProperty('transform-origin')
}

function beginHeldMotion(e) {
  stopHeldMotion()
  for (const running of bodyEl.getAnimations()) running.cancel()
  if (cfg.reduceMotion || cfg.dragPhysics === false || !visible) return
  const box = petEl.getBoundingClientRect()
  // The artwork can be mirrored; translate the screen grab point back into
  // its local coordinates before applying rotation to the inner body.
  const visualX = down.clientX - box.left
  const x = cfg.flip ? box.width - visualX : visualX
  const y = down.clientY - box.top
  bodyEl.style.transformOrigin = `${x}px ${y}px`
  // 자연스럽게(기본): 약 35도까지 기울고 부드러운 벽에서 돌아온다. 집어 드는 순간의 툭 튐도 걸러 낸다.
  // 빙글빙글: 원래 0.5.0 동작(제한 없음, 여러 바퀴).
  const natural = cfg.swingStyle !== 'spin'
  pendulum = window.PetMotion.create({ length: cfg.size * 0.5, ...(natural ? { limit: SWING_LIMIT_RAD, smoothing: SWING_SMOOTHING } : {}) })
  pendulum.begin(down.x, down.at)
  pendulum.move(e.screenX, e.timeStamp)
  heldTick = at => {
    heldFrame = null
    if (!dragging || !pendulum || !visible) return
    // Mirroring must not reverse the visual response to the user's hand.
    const angle = pendulum.step(at) * (cfg.flip ? -1 : 1)
    heldAngle = angle
    bodyEl.style.transform = `rotate(${angle.toFixed(3)}deg)`
    if (!pendulum.isSettled()) wakeHeldMotion()
  }
  wakeHeldMotion()
}

function wakeHeldMotion() {
  if (heldFrame === null && heldTick && visible) heldFrame = requestAnimationFrame(heldTick)
}

stage.addEventListener('pointerdown', e => {
  if (!cfg || e.button !== 0 || down) return
  finishSettle() // 되돌리는 중에 다시 잡으면 앞의 끌기를 먼저 끝맺는다
  // 말풍선이 열려 있으면 캐릭터 어디를 눌러도(머리 포함) 누르는 순간 닫는다.
  // 같은 클릭이 손을 뗄 때 다시 여는 일이 없게 표시해 둔다.
  const closingChat = bubbleOpen
  if (closingChat) closeBubble()
  sound.unlock()
  const head = onHead(e) && (!locked || cfg.lockedPetting)
  down = { x: e.screenX, y: e.screenY, clientX: e.clientX, clientY: e.clientY, at: e.timeStamp, head, pointerId: e.pointerId, closingChat }
  dragging = false
  stage.setPointerCapture(e.pointerId)
  if (head) pat(e)
})
stage.addEventListener('pointermove', e => {
  if (!cfg) return
  if (!down) {
    stage.classList.toggle('over-head', onHead(e) && (!locked || cfg.lockedPetting))
    return
  }
  if (down.pointerId !== e.pointerId) return
  if (down.head) {
    // 머리 위에서 움직이는 건 끌기가 아니라 문지르기다.
    if (e.timeStamp - lastRub > 320) {
      lastRub = e.timeStamp
      heart()
      sound.pat()
    }
    return
  }
  if (locked || cfg.dragEnabled === false) return
  const dx = e.screenX - down.x
  const dy = e.screenY - down.y
  if (!dragging && Math.hypot(dx, dy) > DRAG_START_PX) {
    dragging = true
    stage.classList.add('dragging')
    window.pet.drag('start')
    recompute()
    beginHeldMotion(e)
  }
  if (dragging) {
    pendulum?.move(e.screenX, e.timeStamp)
    wakeHeldMotion()
    // 창은 화면이 한 번 그려질 때마다 한 번만 옮긴다. 마우스가 1초에 수백 번 움직여도 창을 그만큼
    // 옮기면 창 관리자가 따라 그리지 못해 깜빡인다.
    pendingMove = [dx, dy]
    if (moveFrame === null) moveFrame = requestAnimationFrame(flushMove)
  }
})
let pendingMove = null
let moveFrame = null
function flushMove() {
  moveFrame = null
  if (!pendingMove || !dragging) return
  const [dx, dy] = pendingMove
  pendingMove = null
  window.pet.drag('move', dx, dy)
}
const release = e => {
  if (!down) return
  if (e.pointerId !== undefined && down.pointerId !== e.pointerId) return
  const { head, closingChat } = down
  const pointerId = down.pointerId
  down = null
  stage.classList.remove('dragging')
  if (!dragging) stopHeldMotion() // 끌던 중이면 settleThenEndDrag가 기울기를 이어받아 되돌린다
  if (head) stopPetting()
  else if (dragging) settleThenEndDrag(e.type === 'pointerup')
  else if (e.type === 'pointerup' && !closingChat && cfg.chatEnabled !== false && (!locked || cfg.lockedChat)) {
    wake()
    if (!bubbleOpen) openBubble()
  }
  dragging = false
  recompute()
  if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId)
}
stage.addEventListener('pointerup', release)
stage.addEventListener('pointercancel', release)
stage.addEventListener('lostpointercapture', release)
window.addEventListener('blur', () => release({ type: 'blur' }))
stage.addEventListener('pointerleave', () => stage.classList.remove('over-head'))
window.addEventListener('contextmenu', e => {
  e.preventDefault()
  window.pet.menu()
})
// 포커스 테두리는 키보드로 조작할 때만: Tab을 누르면 켜고, 마우스로 누르면 끈다.
window.addEventListener('pointerdown', () => document.body.classList.remove('keyboard'), true)
window.addEventListener('keydown', e => {
  if (e.key === 'Tab') document.body.classList.add('keyboard')
  if (e.key === 'Escape' && bubbleOpen) closeBubble()
  if (e.target === stage && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    if (!cfg || cfg.chatEnabled === false || (locked && !cfg.lockedChat)) return
    sound.unlock()
    wake()
    if (!bubbleOpen) openBubble()
    else closeBubble()
  }
})
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.isComposing) e.preventDefault()
})
input.addEventListener('input', touch)

// ── 마우스 받기 알림 ───────────────────────────────────────────────────
// 캐릭터 창은 회전 여유만큼 캐릭터보다 크고, 빈 자리는 마우스가 통과한다.
// 캐릭터에 닿았는지·누르고 있는지를 main에 알려 즉시 받게 한다.
let hoverSent = null
function reportHover(over, held = !!down) {
  const key = `${over}/${held}`
  if (key === hoverSent) return
  hoverSent = key
  window.pet.hover?.(over, held)
}
document.addEventListener('mousemove', e => {
  const t = e.target instanceof Element ? e.target : null
  reportHover(!!t && stage.contains(t))
})
document.addEventListener('mouseleave', () => { if (!down) reportHover(false) })
stage.addEventListener('pointerdown', () => reportHover(true, true), true)
window.addEventListener('pointerup', () => reportHover(true, false), true)

// ── 시작 ───────────────────────────────────────────────────────────────
window.pet.onLayout?.(applyWindowLayout)
window.pet.onChatVisibility?.(state => {
  bubbleOpen = !!state.open
  if (!spinner.hidden) placeSpinner() // 말풍선이 열리고 닫힘에 따라 머리 위 ↔ 옆
  if (!bubbleOpen) sound.stop()
})
window.pet.onChatStarted?.(() => {
  busy = true
  speechStartedAt = null
  sound.unlock()
  setLocal('thinking')
})
window.pet.onChatCancelled?.(() => {
  finish(true)
  setLocal(null)
})
window.pet.onVisibility?.(value => {
  mainVisible = !!value
  syncVisibility()
})
document.addEventListener('visibilitychange', syncVisibility)

function syncVisibility() {
  const next = mainVisible && document.visibilityState !== 'hidden'
  if (next === visible) return
  visible = next
  document.body.classList.toggle('is-hidden', !visible)
  sound.setVisible(visible)
  window.PetAnimator.setPaused(!visible)
  if (!visible) {
    clearTimeout(stateTimer)
    stateTimer = null
    clearTimeout(blinkTimer)
    clearTimeout(flapTimer)
    if (down) release({ type: 'hidden' })
    stopHeldMotion()
    finishSettle()
    pausedAnimations = document.getAnimations().filter(animation => animation.playState === 'running')
    for (const animation of pausedAnimations) animation.pause()
  } else {
    for (const animation of pausedAnimations) {
      if (animation.playState === 'paused') animation.play()
    }
    pausedAnimations = []
    recompute()
    applyFace()
  }
}

window.pet.onCfg(next => {
  const before = cfg
  cfg = next
  const chainChanged = before && String(before.chatChain) !== String(cfg.chatChain)
  if ((cfg.chatChain?.length > 1 && chainChanged) || (before && cfg.chatProvider !== before.chatProvider)) limitUntil = 0
  sound.configure(cfg)
  if (chainChanged) sound.stop()
  if (down && (cfg.locked || cfg.dragEnabled === false || (down.head && !cfg.petting))) release({ type: 'settings' })
  if (cfg.reduceMotion || cfg.dragPhysics === false) stopHeldMotion()
  if (cfg.chatEnabled === false) closeBubble(true)
  if (!layers) return
  layout()
  onInput({ locked: cfg.locked, armed })
  recompute()
})
window.pet.onClaudeCode(state => {
  cc = state
  recompute()
})

window.pet.init().then(init => {
  cfg = init.cfg
  sound.configure(cfg)
  layers = init.layers
  bust = init.bust
  cc = init.ccState
  if (typeof init.chatOpen === 'boolean') bubbleOpen = init.chatOpen
  if (typeof init.visible === 'boolean') mainVisible = init.visible
  applyWindowLayout(init.layout || geometry)
  build()
  layout()
  applyFace()
  onInput({ locked, armed })
  recompute()
  syncVisibility()
})
window.addEventListener('pagehide', () => {
  clearTimeout(stateTimer)
  clearTimeout(blinkTimer)
  clearTimeout(flapTimer)
  stopHeldMotion()
  sound.dispose()
})
