// 클로(Clau): Claude 창 한쪽에 붙어 산다. 원하면 화면 위에 따로 떠 있을 수도 있다.
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, safeStorage, shell, Notification } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('./settings-store')
const chat = require('./chat')
const runningApps = require('./running-apps')
const soundFiles = require('./sound-files')
const credentials = require('./credentials')
const modelLists = require('./models')
const updater = require('./updater')
const { layout: windowLayout } = require('./window-layout')
const trackers = require('./tracker')
const { stripEmoji } = require('./clean')

// 네이티브 Wayland에서는 창이 스스로 위치를 정하거나 항상 위에 있을 수 없다.
// XWayland로 띄우면 둘 다 되는데, 이 선택은 시작할 때 명령줄로만 할 수 있어서
// 옵션 없이 켜졌다면 옵션을 붙여 한 번 다시 시작한다.
const X11_FLAG = '--ozone-platform=x11'
const needsX11Restart =
  process.platform === 'linux' && !process.argv.includes(X11_FLAG) && !!process.env.DISPLAY && !process.env.CLAU_NATIVE

const ASSETS = path.join(__dirname, '..', 'assets')
const CLAUDE_HOME = path.join(os.homedir(), '.claude')
const CLAU_HOME = path.join(CLAUDE_HOME, 'clau')
const STATE_FILE = path.join(CLAU_HOME, 'state.json') // Claude Code 쪽 mod가 지금 하는 일을 적는다
const APP_FILE = path.join(CLAU_HOME, 'app.json') // mod가 클로를 깨울 때 읽는다: 실행 파일이 어디 있는지
const MOD_SOURCE = path.join(__dirname, '..', 'claude-mod')
const MOD_DIR = path.join(CLAU_HOME, 'mod')
const CLAUDE_SETTINGS = path.join(CLAUDE_HOME, 'settings.json')
const BUST = 0.69 // 상반신 보기: 위에서부터 이만큼만 보인다
const HEADROOM = 0.06 // 화면(pet.js)과 같은 값: 그림 위쪽 여백
const SEAT_SNAP_PX = 16 // 자동 모드: 바닥에서 이만큼 안이면 앉는다
const SEAT_SLIDE_MS = 240
// 말풍선 상자(최대 340px) 둘레에 여유를 둔다: 등장할 때 살짝 부풀어 넘치는 모양과 그림자가 창 끝에 잘리지 않도록.
const BUBBLE = { width: 384, height: 234 }
const HIDE_DELAY_MS = 200 // 포커스가 잠깐 비는 순간에 깜빡이지 않도록
const LOCK_DWELL_MS = 600 // 고정 모드: 이만큼 마우스를 올려 두면 우클릭을 받는다
const TESTING = !!process.env.CLAU_SHOT
const REPO = updater.repoSlug(require('../package.json'))
const UPDATE_FIRST_CHECK_MS = 20_000
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000
const MODELS_FRESH_MS = 5 * 60 * 1000

let win = null
let settingsWin = null
let bubbleWin = null
let tray = null
let layers = null
let petPos = { x: 0, y: 0 } // 말풍선을 접었을 때 창의 왼쪽 위
let expanded = false
let bubbleClosing = false
let lookTimer = null // 눈이 마우스를 따라볼 때: 마우스 자리를 묻는 주기
let lastLook = ''
let focusChatUntil = 0 // 이때까지 말풍선이 입력을 받을 수 있게 앞으로 나와야 한다(방금 사용자가 열었다)
let lastBubbleLayout = null
let lastLayout = null
let lastLayoutSent = ''
let dragFrom = null
let seatSlide = null // 자동 모드: 놓은 뒤 바닥으로 미끄러져 앉는 중
let history = []
let running = null
let soundDialogOpen = false
let groqCredential = null

// 따라붙을 창(Claude)의 지금 모습
let tracker = null
let track = { found: false, focused: false, bounds: null, minimized: false }
let trackError = null
let trackerGeneration = 0
let wmScale = 1 // 창 관리자 단위 → Electron 단위
let hideTimer = null

// 고정 모드
let armed = true // 지금 마우스를 받는 중인지
let hoverSince = 0
let menuOpen = false
let lastInput = ''
let inputTimer = null
let rendererHover = false // 화면이 알려 준: 마우스가 캐릭터 위에 있는가
let pointerHeld = false // 화면이 알려 준: 캐릭터를 누르고 있는가
let stateWatcher = null
let stateRefreshTimer = null
let cachedState = null
let stateLoaded = false
const cliCache = new Map()
const modelCache = new Map() // 'codex' | 'groq' → { at, key, pending }
// 업데이트: idle → checking → latest | available → downloading → installing, 어디서든 error
let update = { state: 'idle', version: null, notes: '', page: null, progress: 0, error: null }
let updateInfo = null
let updateTimer = null
let updateChecked = false

const clamp = (value, lo, hi) => Math.max(lo, Math.min(value, hi))

// ── 크기와 자리 ────────────────────────────────────────────────────────
/** 보여 줄 영역: 작은 친구를 숨기면 캐릭터만큼만. */
function viewRect(cfg) {
  return cfg.showBuddy || !layers.layers.base ? layers.view : layers.layers.base
}

/**
 * 지금 보여 줄 모양.
 *   전신·상반신: 정한 크기가 보이는 높이다.
 *   자동: 정한 크기가 전신 높이다. 바닥에 앉으면 같은 크기 그대로 아래만 가린 상반신이 된다.
 *         끄는 동안과 앉으러 미끄러지는 동안은 전신을 그리고 바닥 밑만 가린다.
 */
function petSize(cfg = store.get()) {
  const [, , vw, vh] = viewRect(cfg)
  if (cfg.view === 'auto') {
    const bust = cfg.seated && !dragFrom && !seatSlide
    const full = cfg.size
    const seat = Math.round(cfg.size * (HEADROOM + BUST * (1 - HEADROOM)))
    return { width: Math.max(40, Math.round((cfg.size * vw) / vh)), height: bust ? seat : full, full, seat, unit: cfg.size, view: bust ? 'bust' : 'full', auto: true }
  }
  const shownH = cfg.view === 'bust' ? vh * BUST : vh
  return { width: Math.max(40, Math.round((cfg.size * vw) / shownH)), height: cfg.size, full: cfg.size, seat: cfg.size, unit: cfg.size, view: cfg.view, auto: false }
}

/** 캐릭터가 서 있는 바닥: 붙는 모드는 앱 창의 아래 끝, 아니면 화면(작업 영역)의 아래 끝. */
function floorAt(pet) {
  const area = screen.getDisplayMatching({ ...petPos, width: pet.width, height: pet.height }).workArea
  let floor = area.y + area.height
  const c = isAttached() ? claudeRect() : null
  if (c) floor = Math.min(floor, c.y + c.height)
  return floor
}

function defaultPosition(cfg) {
  const area = screen.getPrimaryDisplay().workArea
  const pet = petSize(cfg)
  return { x: area.x + area.width - pet.width - 60, y: area.y + area.height - pet.height - 20 }
}

/** Claude 창에 붙는 모드인지. 창을 추적할 수 없는 환경에서는 자유 모드로 돈다. */
function isAttached() {
  return !TESTING && store.get().placement === 'claude' && !!tracker?.supported && !trackError
}

/** 추적기가 알려 준 창의 자리를 Electron 단위로. */
function claudeRect() {
  const b = track.bounds
  if (!track.found || !b) return null
  if (tracker.units === 'wm') {
    return { x: b.x * wmScale, y: b.y * wmScale, width: b.width * wmScale, height: b.height * wmScale }
  }
  if (tracker.units === 'px') {
    if (process.platform === 'win32') return screen.screenToDipRect(null, b)
    const k = screen.getPrimaryDisplay().scaleFactor || 1
    return { x: b.x / k, y: b.y / k, width: b.width / k, height: b.height / k }
  }
  return b
}

/**
 * 창 관리자가 본 펫 창과 Electron이 아는 펫 창을 견주어 단위 비율을 맞춘다.
 * 창 크기를 바꾸는 도중에는 두 값이 잠깐 어긋나므로, 있을 법한 비율로만 맞춘다.
 */
function calibrate(own) {
  if (!own || !win || !win.isVisible() || own.width < 40) return
  const ratio = win.getBounds().width / own.width
  const k = screen.getPrimaryDisplay().scaleFactor || 1
  const best = [1, k, 1 / k].reduce((a, b) => (Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a))
  if (Math.abs(best - ratio) < 0.05) wmScale = best
}

function attachedPos(cfg, c) {
  const pet = petSize(cfg)
  const a = cfg.attachPos
  const x = a.corner[1] === 'r' ? c.x + c.width - pet.width - a.dx : c.x + a.dx
  const y = a.corner[0] === 'b' ? c.y + c.height - pet.height - a.dy : c.y + a.dy
  // 언제나 Claude 창 안에 머문다.
  return {
    x: Math.round(clamp(x, c.x, c.x + c.width - pet.width)),
    y: Math.round(clamp(y, c.y, c.y + c.height - pet.height + sinkOf(pet))),
  }
}

/** 자동 모드에서 바닥 밑으로 들어가도 되는 깊이: 전신으로 그릴 때 상반신만 남을 때까지. */
const sinkOf = pet => (pet.auto && pet.height > pet.seat ? pet.height - pet.seat : 0)

/** 끌어다 놓은 자리를, 가장 가까운 모서리에서 떨어진 거리로 기억한다. */
function toAttachPos(pos, c, pet) {
  const right = pos.x + pet.width / 2 > c.x + c.width / 2
  const bottom = pos.y + pet.height / 2 > c.y + c.height / 2
  return {
    corner: (bottom ? 'b' : 't') + (right ? 'r' : 'l'),
    dx: Math.max(0, Math.round(right ? c.x + c.width - pos.x - pet.width : pos.x - c.x)),
    dy: Math.max(0, Math.round(bottom ? c.y + c.height - pos.y - pet.height : pos.y - c.y)),
  }
}

/**
 * 캐릭터 창의 자리. 창은 언제나 '집어 들었을 때' 크기(회전 여유 포함)로 둔다. 예전엔 집을 때 키우고
 * 놓을 때 줄였는데, 크기가 바뀌는 순간 직전 화면이 한 프레임 늘어나거나 밀려 보여서 깜빡였다.
 * 자동 모드도 전신 크기 창을 그대로 쓰고 아래만 가려서, 전신과 상반신을 오갈 때 창이 바뀌지 않는다.
 * 빈 자리는 마우스가 통과한다(syncInput).
 */
function applyBounds() {
  if (!win) return
  const cfg = store.get()
  const pet = petSize(cfg)
  const box = { width: pet.width, height: pet.full }
  const area = screen.getDisplayMatching({ ...petPos, ...box }).workArea
  const art = { ...box, artWidth: pet.width * 0.94, artTop: pet.unit * HEADROOM, artHeight: pet.auto ? pet.unit * (1 - HEADROOM) : pet.unit * (1 - HEADROOM) / (cfg.view === 'bust' ? BUST : 1) }
  const next = windowLayout({ position: petPos, pet: art, bubble: BUBBLE, area, expanded: false, dragging: true, sink: pet.auto ? pet.full - pet.seat : 0 })
  petPos = next.position
  // 화면은 창 안에서 캐릭터가 놓일 자리만 알면 된다. 창 크기가 고정이라 앵커 없이 픽셀로 준다.
  const stage = { left: next.stage.left, top: next.stage.top, width: pet.width, height: pet.height }
  // 가리는 선: 상반신은 상자 아래 끝, 자동 모드는 바닥. 끄는 중의 일반 전신·상반신은 흔들릴 수 있게 두지 않는다.
  let cut = null
  if (pet.auto) {
    // 앉아 있으면 상반신 선에서, 끄는 중이면 바닥에서 자른다. 그림은 언제나 전신 길이다.
    const visible = Math.min(pet.height, floorAt(pet) - petPos.y)
    if (visible < pet.full) cut = Math.max(pet.seat, Math.round(visible))
  } else if (cfg.view === 'bust' && !dragFrom) cut = pet.height
  if (cut !== null) stage.cut = cut
  const message = { stage, shape: { width: pet.width, height: pet.height, unit: pet.unit, view: pet.view, auto: pet.auto } }
  lastLayout = { ...next, stage, shape: message.shape }
  if (JSON.stringify(message) !== lastLayoutSent) {
    lastLayoutSent = JSON.stringify(message)
    win.webContents.send('pet:layout', lastLayout)
  }
  // 크기가 그대로면 옮기기만 한다(크기까지 다시 정하면 X11·Windows에서 창이 다시 그려지며 깜빡인다).
  const current = win.getBounds()
  if (current.width !== next.bounds.width || current.height !== next.bounds.height) win.setBounds(next.bounds)
  else if (current.x !== next.bounds.x || current.y !== next.bounds.y) win.setPosition(next.bounds.x, next.bounds.y)
  if (bubbleWin?.isVisible()) placeBubble()
}

function chatLayout() {
  const pet = petSize(store.get())
  const area = screen.getDisplayMatching({ ...petPos, ...pet }).workArea
  const result = windowLayout({ position: petPos, pet, bubble: BUBBLE, area, expanded: true })
  const below = result.bubble.side === 'below'
  const bounds = {
    x: result.bounds.x + result.bubble.left,
    y: result.bounds.y + result.bubble.top - (below ? 14 : 0),
    width: result.bubble.width,
    height: result.bubble.height + 14,
  }
  return { bounds, width: bounds.width, height: bounds.height, originX: result.bubble.originX, originY: below ? 2 : bounds.height - 2, side: result.bubble.side }
}

function placeBubble() {
  if (!bubbleWin || bubbleWin.isDestroyed()) return
  const next = chatLayout()
  const current = bubbleWin.getBounds()
  if (['x', 'y', 'width', 'height'].some(key => current[key] !== next.bounds[key])) bubbleWin.setBounds(next.bounds)
  if (JSON.stringify(next) !== JSON.stringify(lastBubbleLayout)) {
    lastBubbleLayout = next
    bubbleWin.webContents.send('chat:layout', next)
  }
}

function sendChat(channel, ...args) {
  for (const target of [win, bubbleWin]) if (target && !target.isDestroyed()) target.webContents.send(channel, ...args)
}

function createBubble() {
  if (bubbleWin) return
  const layout = chatLayout()
  const me = new BrowserWindow({
    ...layout.bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    hasShadow: false, skipTaskbar: true, title: 'Clau Chat', acceptFirstMouse: true,
    // 보통 창이 아니라 도구 창으로 만든다. Windows는 작업 표시줄·Alt+Tab에서 빠지고, Linux는 창 관리자와
    // 창 꾸미기 효과(둥근 모서리·테두리 같은)가 말풍선 둘레에 네모난 테두리를 그리지 않는다.
    ...(process.platform !== 'darwin' ? { type: 'toolbar' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  })
  bubbleWin = me
  lastBubbleLayout = null
  me.setMenuBarVisibility(false)
  me.setAlwaysOnTop(isAttached() || store.get().alwaysOnTop, 'floating')
  if (process.platform === 'darwin') me.setVisibleOnAllWorkspaces(!isAttached() && store.get().alwaysOnTop, { visibleOnFullScreen: true })
  me.loadFile(path.join(__dirname, 'bubble.html'))
  me.webContents.once('did-finish-load', () => {
    if (bubbleWin !== me) return
    if (expanded && wantVisible()) focusBubble()
    me.webContents.send('chat:visibility', { open: expanded, layout: chatLayout() })
  })
  me.on('closed', () => {
    if (bubbleWin !== me) return
    bubbleWin = null
    expanded = false
    bubbleClosing = false
    sendChat('chat:visibility', { open: false, layout: chatLayout() })
    syncInput()
  })
}

/** 말풍선을 보여 주고 바로 입력할 수 있게 한다. */
function focusBubble() {
  if (!bubbleWin) return
  // macOS: Dock 아이콘 없이 사는 앱이라, 앱을 앞으로 가져와야 입력 칸에 글자가 들어간다.
  if (process.platform === 'darwin') app.focus({ steal: true })
  bubbleWin.show()
  bubbleWin.focus()
  bubbleWin.webContents.focus()
}

function setChatOpen(on) {
  on = !!on && store.get().chatEnabled
  if (on) {
    expanded = true
    bubbleClosing = false
    focusChatUntil = Date.now() + 2000
    createBubble()
    placeBubble()
    if (wantVisible() && !bubbleWin.webContents.isLoading()) focusBubble()
  } else {
    if (!expanded && !bubbleClosing) return
    expanded = false
    bubbleClosing = !!bubbleWin?.isVisible()
  }
  sendChat('chat:visibility', { open: on, layout: chatLayout() })
  syncInput()
}

/** 모드에 맞는 자리로 옮긴다. 끄는 중에는 손을 따라가야 하므로 건드리지 않는다. */
function place() {
  if (!win || dragFrom || seatSlide) return
  const cfg = store.get()
  if (isAttached()) {
    const c = claudeRect()
    if (c) petPos = attachedPos(cfg, c)
  } else {
    const p = cfg.position
    petPos = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { ...p } : defaultPosition(cfg)
  }
  applyBounds()
}

// ── 보이기와 숨기기 ────────────────────────────────────────────────────
function wantVisible() {
  if (!isAttached()) return true
  if (!track.found || track.minimized) return false
  return store.get().showWhen === 'open' || track.focused
}

function setOnTop() {
  if (!win) return
  // 붙는 모드에서는 Claude 창보다 위에 있어야 보인다.
  const on = isAttached() || store.get().alwaysOnTop
  win.setAlwaysOnTop(on, 'floating')
  bubbleWin?.setAlwaysOnTop(on, 'floating')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(on && !isAttached(), { visibleOnFullScreen: true })
  if (process.platform === 'darwin') bubbleWin?.setVisibleOnAllWorkspaces(on && !isAttached(), { visibleOnFullScreen: true })
}

function syncVisibility() {
  if (!win) return
  if (wantVisible()) {
    clearTimeout(hideTimer)
    hideTimer = null
    if (!win.isVisible()) {
      win.showInactive()
      win.webContents.send('pet:visibility', true)
      syncLook()
      setOnTop()
      place()
      syncInput()
    }
    if (expanded && bubbleWin && !bubbleWin.isVisible() && !bubbleWin.webContents.isLoading()) {
      placeBubble()
      bubbleWin.showInactive()
      bubbleWin.webContents.send('pet:visibility', true)
    }
  } else if (win.isVisible() && !hideTimer) {
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (win && !wantVisible()) {
        win.webContents.send('pet:visibility', false)
        win.hide()
        syncLook()
        bubbleWin?.webContents.send('pet:visibility', false)
        bubbleWin?.hide()
        syncInput()
      }
    }, HIDE_DELAY_MS)
  }
}

// ── 창 추적 ────────────────────────────────────────────────────────────
function startTracker() {
  const generation = ++trackerGeneration
  tracker?.stop()
  tracker = null
  trackError = null
  track = { found: false, focused: false, bounds: null, minimized: false }
  if (TESTING) return
  // Free pets do not need another app's geometry. KWin's event-only bridge is
  // retained for its Wayland cursor hit testing in locked mode.
  if (store.get().placement === 'free' && trackers.pick() !== 'kwin') return
  // 창 관리자가 아무 소식도 주지 않으면(스크립트가 막힌 경우 등) 숨은 채로 남지 않게 한다.
  let heard = false
  setTimeout(() => {
    if (generation !== trackerGeneration || heard || trackError) return
    trackError = '창 관리자가 응답하지 않아요.'
    setOnTop()
    place()
    syncVisibility()
  }, 3000)
  tracker = trackers.create({
    target: store.get().targetAppSelection || store.get().targetApp,
    showWhen: store.get().showWhen,
    taskbar: store.get().showInDock,
    look: wantsLook(),
    onCursor: (x, y) => sendLook({ x: x * wmScale, y: y * wmScale }),
    pid: process.pid,
    dir: app.getPath('userData'),
    wantsFocus: () => expanded && Date.now() < focusChatUntil,
    hitRect: () => {
      // 창 관리자 단위로: Electron 단위 = 창 관리자 단위 × wmScale
      const st = lastLayout?.stage
      if (!win || !st) return ''
      const k = wmScale || 1
      return JSON.stringify([st.left / k, st.top / k, st.width / k, Math.min(st.height, st.cut ?? Infinity) / k])
    },
    onState: state => {
      if (generation !== trackerGeneration) return
      heard = true
      trackError = null
      track = state
      calibrate(state.own)
      place()
      syncVisibility()
      syncInput()
      debugDump()
    },
    onFail: err => {
      if (generation !== trackerGeneration) return
      // 추적이 안 되면 숨은 채로 남지 않도록 자유 모드처럼 보여 준다.
      trackError = String(err?.message || err)
      setOnTop()
      place()
      syncVisibility()
    },
  })
}

// ── 눈이 마우스 따라보기 ───────────────────────────────────────────────
function wantsLook(cfg = store.get()) {
  return !!cfg.lookAtCursor && !cfg.reduceMotion && !TESTING
}

/** 마우스 자리를 화면에 알린다(펫 창 기준). 같은 자리면 보내지 않는다. */
function sendLook(point) {
  if (!win || !win.isVisible() || !wantsLook()) return
  const b = win.getBounds()
  const x = Math.round(point.x - b.x)
  const y = Math.round(point.y - b.y)
  const text = `${x},${y}`
  if (text === lastLook) return
  lastLook = text
  win.webContents.send('pet:look', { x, y })
}

/** 켜져 있고 보이는 동안만 마우스를 살핀다. KDE(Wayland)는 창 관리자 스크립트가 알려 준다. */
function syncLook() {
  clearInterval(lookTimer)
  lookTimer = null
  if (!win) return
  if (!wantsLook() || !win.isVisible()) {
    if (lastLook) win.webContents.send('pet:look', null)
    lastLook = ''
    return
  }
  if (tracker?.kind === 'kwin' && !trackError) return
  lookTimer = setInterval(() => sendLook(screen.getCursorScreenPoint()), 33)
}

// ── 고정 모드: 마우스를 받을지 말지 ─────────────────────────────────────
/** 마우스를 받아야 하는 화면 영역: 창 전체가 아니라 그 안의 캐릭터 자리. */
function petRect() {
  const b = win.getBounds()
  const st = lastLayout?.stage
  return st ? { x: b.x + st.left, y: b.y + st.top, width: st.width, height: Math.min(st.height, st.cut ?? Infinity) } : b
}

function cursorOverPet() {
  // 화면(렌더러)이 캐릭터 위에 마우스가 있다고 알려 왔으면 그걸 믿는다. 가장 빠르고 정확하다.
  if (rendererHover) return true
  // Wayland에서는 앱이 화면 전체의 마우스 위치를 알 수 없어서, 창 관리자가 알려 준 값을 쓴다.
  if (tracker?.kind === 'kwin' && !trackError) return !!track.hover
  const p = screen.getCursorScreenPoint()
  const r = petRect()
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}

function syncInput() {
  clearTimeout(inputTimer)
  inputTimer = null
  if (!win) return
  const cfg = store.get()
  if (cfg.locked && win.isVisible() && !expanded && !menuOpen && tracker?.kind !== 'kwin') inputTimer = setTimeout(syncInput, 100)
  // 마우스 이동을 화면으로 전달할 수 없는 Linux에서는 캐릭터에 닿았는지 직접 살핀다.
  else if (!cfg.locked && process.platform === 'linux' && win.isVisible() && tracker?.kind !== 'kwin') inputTimer = setTimeout(syncInput, 100)
  if (TESTING || pointerHeld || dragFrom) {
    armed = true // 누르고 있는 동안 놓치면 손을 뗀 걸 모른다
    hoverSince = 0
  } else if (!cfg.locked) {
    // 창은 캐릭터보다 크다. 빈 자리는 통과시켜 뒤의 앱 창을 그대로 누를 수 있게 한다.
    armed = menuOpen || (win.isVisible() && cursorOverPet())
    hoverSince = 0
  } else if (expanded || menuOpen) {
    armed = true // 대화 중이거나 메뉴가 떠 있는 동안에는 계속 받는다
  } else {
    // Claude가 앞에 있을 때만 다가갈 수 있다. 추적이 안 되는 환경에서는 언제나.
    const reachable = tracker?.supported && !trackError ? track.focused : true
    if (!reachable || !win.isVisible() || !cursorOverPet()) {
      armed = false
      hoverSince = 0
    } else {
      if (!hoverSince) hoverSince = Date.now()
      // 대화나 쓰다듬기를 허용했다면 바로, 아니면 잠깐 머문 뒤에.
      const dwell = (cfg.chatEnabled && cfg.lockedChat) || (cfg.petting && cfg.lockedPetting) ? 0 : LOCK_DWELL_MS
      armed = Date.now() - hoverSince >= dwell
      if (!armed && tracker?.kind === 'kwin') inputTimer = setTimeout(syncInput, Math.max(1, dwell - (Date.now() - hoverSince)))
    }
  }
  const text = `${cfg.locked}/${armed}`
  if (text === lastInput) return
  lastInput = text
  // forward: 통과시키는 동안에도 마우스 움직임은 화면에 알려서, 캐릭터에 닿는 즉시 다시 받는다.
  win.setIgnoreMouseEvents(!armed, { forward: true })
  win.webContents.send('pet:input', { locked: cfg.locked, armed: cfg.locked ? armed : true })
}

// ── 창 ─────────────────────────────────────────────────────────────────
function createPet() {
  const cfg = store.get()
  petPos = cfg.position && Number.isFinite(cfg.position.x) ? { ...cfg.position } : defaultPosition(cfg)
  const me = new BrowserWindow({
    ...petSize(cfg),
    x: petPos.x,
    y: petPos.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    // macOS: 다른 앱이 앞에 있어도 첫 클릭부터 받는다(없으면 머리 연타의 첫 탭이 창 활성화에 먹힌다).
    acceptFirstMouse: true,
    // 집어 들면 회전 여유만큼 창이 화면보다 커질 수 있다. macOS는 기본적으로 창을 화면 안으로
    // 줄이거나 밀어 넣는데, 그러면 창 원점이 바뀌어 캐릭터가 순간 이동한 것처럼 보였다.
    enableLargerThanScreen: true,
    skipTaskbar: !cfg.showInDock,
    // Windows에서는 도구 창으로 만들어 작업 표시줄과 Alt+Tab 목록에서 뺀다.
    ...(process.platform === 'win32' && !cfg.showInDock ? { type: 'toolbar' } : {}),
    title: 'Clau',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  })
  win = me
  lastLayout = null
  me.setMenuBarVisibility(false)
  me.loadFile(path.join(__dirname, 'pet.html'))
  me.on('closed', () => {
    if (win !== me) return // 새 창으로 갈아 끼운 뒤라면 그냥 사라진다
    win = null
    bubbleWin?.destroy()
    app.quit()
  })
  me.webContents.once('did-finish-load', () => {
    lastInput = ''
    syncInput()
    syncLook()
  })
  setOnTop()
  place()
  // 붙는 모드에서는 Claude 창을 찾은 뒤에 나타난다.
  if (wantVisible()) me.showInactive()
}

/** Dock(macOS)이나 작업 표시줄에 아이콘을 보일지. */
function syncDock(before) {
  const show = store.get().showInDock
  if (process.platform === 'darwin') {
    if (show) app.dock?.show()
    else app.dock?.hide()
    return
  }
  if (!before || before.showInDock === show) return win?.setSkipTaskbar(!show)
  if (process.platform === 'win32') {
    // 도구 창인지는 만들 때 정해지므로 창을 새로 만든다.
    const old = win
    setChatOpen(false)
    bubbleWin?.hide()
    bubbleClosing = false
    createPet()
    old?.destroy()
  } else {
    win?.setSkipTaskbar(!show)
    if (tracker?.kind === 'kwin') startTracker() // KWin 쪽 표시도 다시 맞춘다
  }
}

function openSettings() {
  cliCache.clear()
  if (settingsWin) return settingsWin.focus()
  settingsWin = new BrowserWindow({
    width: 740,
    height: 660,
    minWidth: 580,
    minHeight: 420,
    title: '클로 설정',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#faf5ef',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.on('closed', () => (settingsWin = null))
}

// ── 설정 적용 ──────────────────────────────────────────────────────────
function setAutostart(on) {
  try {
    if (process.platform === 'linux') {
      const file = path.join(os.homedir(), '.config', 'autostart', 'clau.desktop')
      if (!on) return fs.rmSync(file, { force: true })
      const exec = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Clau\nExec=${exec}\nX-GNOME-Autostart-enabled=true\n`)
    } else {
      app.setLoginItemSettings({ openAtLogin: on })
    }
  } catch {
    // 자동 실행 등록 실패는 조용히 넘긴다. 설정 창에서 다시 켤 수 있다.
  }
}

function syncTray() {
  const cfg = store.get()
  if (!cfg.tray || TESTING) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    try {
      tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')).resize({ width: 22, height: 22 }))
      tray.setToolTip('클로')
    } catch {
      tray = null // 트레이가 없는 데스크톱
      return
    }
  }
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()))
}

/** 설정이 바뀐 뒤 창·트레이·화면에 두루 반영한다. */
function refresh(before, cfg) {
  if (before.targetApp !== cfg.targetApp || before.placement !== cfg.placement || before.showWhen !== cfg.showWhen || JSON.stringify(before.targetAppSelection) !== JSON.stringify(cfg.targetAppSelection)) startTracker()
  if (before.chatProvider !== cfg.chatProvider || (before.chatEnabled && !cfg.chatEnabled)) {
    clearChat()
  }
  else if (String(before.chatChain) !== String(cfg.chatChain)) cancelChat(true)
  if (before.claudePath !== cfg.claudePath || before.model !== cfg.model) chat.clearAvailability()
  if (before.codexPath !== cfg.codexPath) modelCache.delete('codex')
  if (before.updateCheck !== cfg.updateCheck) scheduleUpdateCheck()
  if (!cfg.chatEnabled) setChatOpen(false)
  if (before.followClaudeCode !== cfg.followClaudeCode) watchState()
  if (before.autostart !== cfg.autostart) setAutostart(cfg.autostart)
  if (before.historyTurns !== cfg.historyTurns) history = cfg.historyTurns ? history.slice(-cfg.historyTurns) : []
  if (before.wakeWithClaude !== cfg.wakeWithClaude) writeAppInfo()
  // KDE는 창 관리자 스크립트가 마우스 자리를 알려 주므로, 켜고 끌 때 스크립트를 다시 올린다.
  if (wantsLook(before) !== wantsLook(cfg) && trackers.pick() === 'kwin') startTracker()
  if (before.view !== cfg.view && cfg.view === 'auto') { place(); seatIfOnFloor() }
  syncDock(before)
  setOnTop()
  place()
  syncVisibility()
  lastInput = ''
  syncInput()
  syncTray()
  syncLook()
  win?.webContents.send('cfg', cfg)
  settingsWin?.webContents.send('cfg', cfg)
  bubbleWin?.webContents.send('cfg', cfg)
  sendClaudeCodeState()
  return cfg
}

function applySettings(patch) {
  const before = store.get()
  if ((dragFrom || seatSlide) && ['size', 'view', 'showBuddy', 'placement', 'targetAppSelection', 'attachPos', 'position', 'locked', 'dragEnabled'].some(key => Object.hasOwn(patch, key))) {
    stopSeatSlide()
    finishDrag(before, false)
  }
  return refresh(before, store.set(patch))
}

function finishDrag(cfg = store.get(), settle = true) {
  if (!dragFrom) return
  dragFrom = null
  if (cfg.view === 'auto' && settle) {
    // 바닥에 닿았거나 바닥 밑으로 들어갔으면 상반신으로 앉는다. 앉을 자리까지 미끄러져 내려간다.
    const pet = petSize(cfg)
    const floor = floorAt(pet)
    if (petPos.y + pet.full >= floor - SEAT_SNAP_PX) return slideToSeat(floor - pet.seat)
    if (cfg.seated) store.set({ seated: false })
  }
  remember(cfg)
  place()
}

/** 지금 자리를 기억한다: 붙는 모드는 앱 창의 모서리에서 떨어진 거리로. */
function remember(cfg = store.get()) {
  const c = isAttached() ? claudeRect() : null
  if (c) store.set({ attachPos: toAttachPos(petPos, c, petSize(cfg)) })
  else store.set({ position: { ...petPos } })
}

function stopSeatSlide() {
  if (!seatSlide) return
  clearTimeout(seatSlide.timer)
  seatSlide = null
}

function slideToSeat(y) {
  stopSeatSlide()
  const from = petPos.y
  const at0 = Date.now()
  const done = () => {
    seatSlide = null
    store.set({ seated: true })
    remember()
    place()
  }
  if (Math.abs(y - from) < 1 || store.get().reduceMotion) {
    petPos = { ...petPos, y }
    return done()
  }
  seatSlide = { timer: null }
  const step = () => {
    if (!seatSlide) return
    const t = Math.min(1, (Date.now() - at0) / SEAT_SLIDE_MS)
    const eased = 1 - (1 - t) ** 3
    petPos = { ...petPos, y: Math.round(from + (y - from) * eased) }
    applyBounds()
    if (t < 1) seatSlide.timer = setTimeout(step, 16)
    else done()
  }
  seatSlide.timer = setTimeout(step, 16)
}

/** 자동 모드로 바꿨을 때: 지금 바닥에 닿아 있으면 그 자리에서 앉는다. */
function seatIfOnFloor() {
  const cfg = store.get()
  if (cfg.view !== 'auto' || dragFrom) return
  const pet = petSize({ ...cfg, seated: false })
  const floor = floorAt(pet)
  const onFloor = petPos.y + pet.full >= floor - SEAT_SNAP_PX
  if (onFloor === cfg.seated) return
  store.set({ seated: onFloor })
  if (onFloor) {
    petPos = { ...petPos, y: floor - pet.seat }
    remember()
  }
}

function clearChat() {
  cancelChat(false)
  history = []
  sendChat('chat:cleared')
}

function cancelChat(notify = false) {
  const job = running
  running = null
  job?.cancel()
  if (notify && job) sendChat('chat:cancelled')
}

function menuTemplate() {
  const cfg = store.get()
  const sizes = [
    ['작게', 150],
    ['보통', 220],
    ['크게', 320],
    ['아주 크게', 450],
  ]
  const canAttach = !!trackers.pick() && !trackError
  return [
    { label: '설정…', click: openSettings },
    ...(update.state === 'available' ? [{ label: `${update.version} 버전으로 업데이트`, click: () => installUpdate() }] : []),
    { type: 'separator' },
    {
      label: '고정 모드',
      type: 'checkbox',
      checked: cfg.locked,
      click: item => applySettings({ locked: item.checked }),
    },
    {
      label: '자리',
      submenu: [
        {
          label: '선택한 앱 창 안에 붙이기',
          type: 'radio',
          enabled: canAttach,
          checked: cfg.placement === 'claude' && canAttach,
          click: () => applySettings({ placement: 'claude' }),
        },
        {
          label: '화면 위에 자유롭게',
          type: 'radio',
          checked: cfg.placement === 'free' || !canAttach,
          click: () => applySettings({ placement: 'free' }),
        },
        { type: 'separator' },
        {
          label: '처음 자리로',
          click: () => applySettings({ attachPos: store.DEFAULT_ATTACH, position: null, seated: false }),
        },
      ],
    },
    {
      label: '크기',
      submenu: sizes.map(([label, size]) => ({
        label,
        type: 'radio',
        checked: cfg.size === size,
        click: () => applySettings({ size }),
      })),
    },
    {
      label: '보이는 범위',
      submenu: [
        ['전신', 'full'],
        ['자동 (바닥에 앉으면 상반신)', 'auto'],
        ['상반신', 'bust'],
      ].map(([label, view]) => ({ label, type: 'radio', checked: cfg.view === view, click: () => applySettings({ view }) })),
    },
    {
      label: 'Claude Code 따라 하기',
      type: 'checkbox',
      checked: cfg.followClaudeCode,
      click: item => applySettings({ followClaudeCode: item.checked }),
    },
    { type: 'separator' },
    { label: '눌러서 대화', type: 'checkbox', checked: cfg.chatEnabled, click: item => applySettings({ chatEnabled: item.checked }) },
    { label: '대화 지우기', click: clearChat },
    { label: '종료', click: () => app.quit() },
  ]
}

function popupMenu() {
  if (!win) return
  menuOpen = true
  syncInput()
  Menu.buildFromTemplate(menuTemplate()).popup({
    window: win,
    callback: () => {
      menuOpen = false
      syncInput()
    },
  })
}

// ── Claude Code 상태 파일 ─────────────────────────────────────────────
function readState(force = false) {
  if (stateLoaded && !force) return cachedState
  stateLoaded = true
  try {
    cachedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    cachedState = null
  }
  return cachedState
}

function sendClaudeCodeState() {
  win?.webContents.send('cc:state', store.get().followClaudeCode ? readState() : null)
}

function watchState() {
  stateWatcher?.close()
  stateWatcher = null
  clearTimeout(stateRefreshTimer)
  if (!store.get().followClaudeCode || TESTING) return
  readState(true)
  let dir = CLAU_HOME
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const retry = () => { stateRefreshTimer = setTimeout(watchState, 5000); stateRefreshTimer.unref?.() }
  try {
    // Watching the directory handles atomic state.json replacement and needs no
    // repeated stat calls. Watching the closest parent handles first installation.
    stateWatcher = fs.watch(dir, { persistent: false }, (event, filename) => {
      const name = filename && String(filename)
      if (dir === CLAU_HOME && name && name !== 'state.json' && name !== path.basename(dir)) return
      clearTimeout(stateRefreshTimer)
      stateRefreshTimer = setTimeout(() => {
        readState(true)
        sendClaudeCodeState()
        if (dir !== CLAU_HOME || !fs.existsSync(dir) || (event === 'rename' && name === path.basename(dir))) watchState()
      }, 25)
    })
    stateWatcher.on('error', () => { stateWatcher?.close(); stateWatcher = null; retry() })
  } catch { retry() }
}

// ── Claude Code 연결 ───────────────────────────────────────────────────
/** 실행 파일이 어디 있는지 적어 둔다. Claude Code 안의 /clau 명령이 이걸 보고 클로를 깨운다. */
function writeAppInfo() {
  try {
    if (!fs.existsSync(CLAUDE_HOME)) return // Claude Code를 쓰지 않는 컴퓨터
    const args = app.isPackaged ? [] : [app.getAppPath()]
    if (process.argv.includes(X11_FLAG)) args.push(X11_FLAG)
    fs.mkdirSync(CLAU_HOME, { recursive: true })
    fs.writeFileSync(
      APP_FILE,
      JSON.stringify({ exec: process.execPath, args, platform: process.platform, wake: store.get().wakeWithClaude }),
    )
  } catch {
    // 못 적어도 클로는 그대로 돈다. /clau 명령만 클로를 찾지 못한다.
  }
}

function readClaudeSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return {}
  return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'))
}

const pluginDirs = settings =>
  String(settings?.env?.CLAUDE_CODE_PLUGIN_DIRS || '')
    .split(path.delimiter)
    .filter(Boolean)

function copyMod() {
  fs.rmSync(MOD_DIR, { recursive: true, force: true })
  fs.cpSync(MOD_SOURCE, MOD_DIR, { recursive: true, filter: src => !src.endsWith('.test.ts') })
}

function modConnected() {
  try {
    return pluginDirs(readClaudeSettings()).includes(MOD_DIR) && fs.existsSync(path.join(MOD_DIR, 'hooks', 'register.ts'))
  } catch {
    return false
  }
}

/**
 * Claude Code가 mod를 읽도록 ~/.claude/settings.json 의 CLAUDE_CODE_PLUGIN_DIRS 에 폴더를 넣거나 뺀다.
 * 그 파일을 읽을 수 없으면 손대지 않고 오류를 낸다.
 */
function connectMod(on) {
  const settings = readClaudeSettings()
  const dirs = pluginDirs(settings).filter(dir => dir !== MOD_DIR)
  if (on) {
    copyMod()
    dirs.push(MOD_DIR)
  } else {
    fs.rmSync(MOD_DIR, { recursive: true, force: true })
  }
  const env = { ...settings.env }
  if (dirs.length) env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(path.delimiter)
  else delete env.CLAUDE_CODE_PLUGIN_DIRS
  const next = { ...settings, env }
  if (!Object.keys(env).length) delete next.env
  const draft = `${CLAUDE_SETTINGS}.clau`
  fs.mkdirSync(CLAUDE_HOME, { recursive: true })
  fs.writeFileSync(draft, `${JSON.stringify(next, null, 2)}\n`)
  fs.renameSync(draft, CLAUDE_SETTINGS)
}

// ── 모델 목록 ──────────────────────────────────────────────────────────
/** 설정 창이 열려 있을 때만 불린다. 같은 목록을 잠깐 사이에 두 번 받아 오지 않는다. */
function listModels(provider, force) {
  if (provider !== 'codex' && provider !== 'groq') return Promise.resolve({ models: [], source: 'none' })
  const key = provider === 'groq' ? (groqCredential?.get() ? 'key' : 'none') : store.get().codexPath
  const saved = modelCache.get(provider)
  if (!force && saved && saved.key === key && Date.now() - saved.at < MODELS_FRESH_MS) return saved.pending
  const pending = provider === 'groq'
    ? modelLists.groq({ key: groqCredential?.get() || '' })
    : modelLists.codex({ bin: chat.findCodex(store.get().codexPath) })
  modelCache.set(provider, { at: Date.now(), key, pending })
  return pending
}

// ── 업데이트 ───────────────────────────────────────────────────────────
/** 설치본만 스스로 바꿀 수 있다. 소스에서 돌릴 때는 git pull 이 업데이트다. */
function canSelfUpdate() {
  if (!app.isPackaged || !updater.targetName()) return false
  const dir = updater.installDir(process.execPath)
  return updater.writable(dir) && updater.writable(path.dirname(dir))
}

function setUpdate(patch) {
  const before = update.state
  update = { ...update, ...patch }
  settingsWin?.webContents.send('update:state', { ...update, canInstall: canSelfUpdate() })
  if (before !== update.state) syncTray() // 메뉴에 업데이트 항목이 생기거나 사라진다
}

function scheduleUpdateCheck() {
  clearTimeout(updateTimer)
  updateTimer = null
  if (TESTING || !REPO || !store.get().updateCheck) return
  // 켜고 조금 뒤에 한 번, 그다음부터는 여섯 시간마다.
  updateTimer = setTimeout(() => checkForUpdate(false), updateChecked ? UPDATE_EVERY_MS : UPDATE_FIRST_CHECK_MS)
  updateTimer.unref?.()
}

async function checkForUpdate(manual) {
  if (['checking', 'downloading', 'installing'].includes(update.state)) return
  updateChecked = true
  setUpdate({ state: 'checking', error: null })
  try {
    updateInfo = await updater.check({ repo: REPO, current: app.getVersion(), target: updater.targetName() })
    if (!updateInfo.available) setUpdate({ state: 'latest', version: updateInfo.version, page: updateInfo.page })
    else {
      setUpdate({ state: 'available', version: updateInfo.version, notes: updateInfo.notes, page: updateInfo.page })
      if (!manual) announceUpdate()
    }
  } catch (err) {
    // 알아서 확인하다 실패한 건 조용히 넘긴다. 다음 차례에 다시 본다.
    setUpdate(manual ? { state: 'error', error: String(err.message || err) } : { state: 'idle' })
  }
  scheduleUpdateCheck()
}

/** 새 버전마다 한 번만 알린다. */
function announceUpdate() {
  if (store.get().updateNotified === update.version) return
  store.set({ updateNotified: update.version })
  if (!Notification.isSupported()) return
  const note = new Notification({
    title: '클로',
    body: canSelfUpdate() ? `새 버전 ${update.version}이 나왔어요. 누르면 바로 바꿔요.` : `새 버전 ${update.version}이 나왔어요.`,
    icon: path.join(ASSETS, 'icon.png'),
    silent: true,
  })
  note.on('click', () => installUpdate())
  note.show()
}

async function installUpdate() {
  if (['checking', 'downloading', 'installing'].includes(update.state)) return
  if (!updateInfo?.available) {
    await checkForUpdate(true)
    if (!updateInfo?.available) return
  }
  // 스스로 바꿀 수 없는 자리면 받는 곳을 열어 준다.
  if (!canSelfUpdate() || !updateInfo.file) return shell.openExternal(updateInfo.page)
  let shown = -1
  setUpdate({ state: 'downloading', progress: 0, error: null })
  try {
    const staged = await updater.stage(updateInfo, {
      onProgress: (phase, ratio) => {
        // 받기 90%, 풀기 10%. 1% 바뀔 때만 화면에 알린다.
        const percent = Math.floor(phase === 'download' ? ratio * 90 : 90 + ratio * 10)
        if (percent !== shown) setUpdate({ progress: (shown = percent) })
      },
    })
    setUpdate({ state: 'installing', progress: 100 })
    updater.swap(staged)
    app.quit()
  } catch (err) {
    setUpdate({ state: 'error', error: String(err.message || err) })
  }
}

// ── IPC ────────────────────────────────────────────────────────────────
function settingsInfo() {
  const find = (provider, custom) => {
    const key = `${provider}:${custom}`
    const entry = cliCache.get(key)
    if (entry && Date.now() - entry.at < 30000) return entry.value
    const value = provider === 'codex' ? chat.findCodex(custom) : chat.findClaude(custom)
    cliCache.set(key, { value, at: Date.now() })
    return value
  }
  return {
    cfg: store.get(),
    saveError: store.getSaveError(),
    groqCredential: groqCredential?.info() || { configured: false, persistent: false },
    models: store.MODELS,
    defaultPersona: store.DEFAULT_PERSONA,
    claudeFound: find('claude', store.get().claudePath),
    codexFound: find('codex', store.get().codexPath),
    stateFile: STATE_FILE,
    modSeen: !!readState(),
    modConnected: modConnected(),
    hasClaudeCode: fs.existsSync(CLAUDE_HOME),
    platform: process.platform,
    version: app.getVersion(),
    update: { ...update, canInstall: canSelfUpdate() },
    tracking: {
      supported: !!trackers.pick() && !trackError,
      error: trackError,
      found: track.found,
    },
  }
}

function wireIpc() {
  ipcMain.handle('pet:init', e => ({
    role: e.sender === bubbleWin?.webContents ? 'bubble' : 'pet',
    cfg: store.get(),
    layers,
    bust: BUST,
    bubble: BUBBLE,
    layout: lastLayout,
    visible: win?.isVisible() ?? true,
    chatOpen: expanded,
    chatLayout: chatLayout(),
    chatVisibility: { open: expanded, layout: chatLayout() },
    ccState: store.get().followClaudeCode ? readState() : null,
  }))
  ipcMain.on('pet:hover', (e, over, held) => {
    if (e.sender !== win?.webContents) return
    rendererHover = !!over
    pointerHeld = !!held
    syncInput()
  })
  ipcMain.on('pet:expand', (_e, on) => {
    setChatOpen(on)
  })
  ipcMain.on('chat:closed', e => {
    if (e.sender !== bubbleWin?.webContents || expanded) return
    bubbleClosing = false
    bubbleWin.hide()
    syncInput()
  })
  ipcMain.on('pet:menu', popupMenu)
  ipcMain.on('pet:drag', (_e, phase, dx, dy) => {
    const cfg = store.get()
    if (!win || cfg.locked || !cfg.dragEnabled) return
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const c = isAttached() ? claudeRect() : null
    if (phase === 'start') {
      stopSeatSlide()
      dragFrom = { ...petPos }
      applyBounds()
    }
    else if (phase === 'move' && dragFrom) {
      const pet = petSize(cfg)
      petPos = { x: Math.round(dragFrom.x + dx), y: Math.round(dragFrom.y + dy) }
      if (c) {
        petPos.x = Math.round(clamp(petPos.x, c.x, c.x + c.width - pet.width))
        petPos.y = Math.round(clamp(petPos.y, c.y, c.y + c.height - pet.height + sinkOf(pet)))
      }
      // 자동 모드: 바닥 밑으로는 상반신만 남을 때까지만 들어간다.
      if (pet.auto) petPos.y = Math.min(petPos.y, floorAt(pet) - pet.seat)
      applyBounds()
    } else if (phase === 'end' && dragFrom) {
      finishDrag(cfg)
    }
  })

  ipcMain.on('chat:ask', (e, question) => {
    cancelChat(false)
    const cfg = store.get()
    if (!cfg.chatEnabled) return sendChat('chat:error', '설정에서 대화를 켜 주세요.')
    if (typeof question !== 'string' || !question.trim() || question.length > 16000) return sendChat('chat:error', '질문은 1~16,000자로 적어 주세요.')
    question = question.trim()
    sendChat('chat:started')
    const tidy = text => (cfg.noEmoji ? stripEmoji(text) : text)
    let job
    job = chat.ask({
      question,
      history,
      cfg,
      groqApiKey: groqCredential?.get() || '',
      cwd: app.getPath('userData'),
      onDelta: (_piece, whole) => { if (running === job) sendChat('chat:delta', tidy(whole)) },
      onRateLimit: info => { if (running === job) sendChat('chat:ratelimit', info) },
      onProvider: info => queueMicrotask(() => { if (running === job) sendChat('chat:provider', info) }),
    })
    running = job
    job.done
      .then(({ text }) => {
        if (running !== job) return
        const answer = tidy(text).trim()
        history = cfg.historyTurns ? [...history, { q: question, a: answer }].slice(-cfg.historyTurns) : []
        sendChat('chat:done', answer)
      })
      .catch(err => {
        if (running !== job) return
        const message =
          err.code === 'ENOENT' ? `${cfg.chatProvider === 'codex' ? 'codex' : 'claude'} 명령을 실행하지 못했어요. 설정에서 경로를 확인해 주세요.` : String(err.message || err)
        sendChat('chat:error', message)
      })
      .finally(() => {
        if (running === job) running = null
      })
  })
  ipcMain.on('chat:cancel', () => cancelChat(true))

  ipcMain.handle('settings:get', settingsInfo)
  ipcMain.handle('settings:apps', () => runningApps.list({ pid: process.pid, dir: app.getPath('userData') }))
  ipcMain.handle('groq:key', (e, value) => {
    if (e.sender !== settingsWin?.webContents) throw new Error('설정 창에서 키를 입력해 주세요.')
    if (value === null) groqCredential.clear()
    else groqCredential.set(value)
    modelCache.delete('groq')
    return settingsInfo()
  })
  ipcMain.handle('models:list', (_e, provider, force) => listModels(provider, !!force))
  ipcMain.handle('update:check', () => checkForUpdate(true).then(settingsInfo))
  ipcMain.handle('update:install', () => { installUpdate(); return settingsInfo() })
  ipcMain.on('update:page', () => { if (update.page || REPO) shell.openExternal(update.page || `https://github.com/${REPO}/releases`) })
  ipcMain.handle('sound:select', async (e, kind) => {
    if (!['petting', 'talking'].includes(kind) || e.sender !== settingsWin?.webContents) throw new Error('설정 창에서 효과음을 선택해 주세요.')
    if (soundDialogOpen) return { cancelled: true, info: settingsInfo() }
    soundDialogOpen = true
    try {
      const result = await dialog.showOpenDialog(settingsWin, {
        title: kind === 'petting' ? '쓰다듬기 효과음 고르기' : '말하기 효과음 고르기',
        properties: ['openFile'],
        filters: [{ name: '효과음 파일', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'webm'] }],
      })
      if (result.canceled || !result.filePaths[0]) return { cancelled: true, info: settingsInfo() }
      const file = await soundFiles.importFile(result.filePaths[0], app.getPath('userData'))
      applySettings({ [`${kind}SoundFile`]: file, [`${kind}Sound`]: 'custom' })
      return { cancelled: false, info: settingsInfo(), file }
    } catch (error) {
      return { cancelled: false, error: String(error.message || error), info: settingsInfo() }
    } finally { soundDialogOpen = false }
  })
  ipcMain.handle('sound:read', async (_e, kind) => {
    if (!['petting', 'talking'].includes(kind)) throw new Error('알 수 없는 효과음이에요.')
    const meta = store.get()[`${kind}SoundFile`]
    const bytes = await soundFiles.readFile(meta, app.getPath('userData'))
    return { id: meta.id, bytes }
  })
  const builtinSounds = require('./sound').BUILTIN
  const builtinCache = new Map()
  ipcMain.handle('sound:builtin', (_e, name) => {
    if (!Object.hasOwn(builtinSounds, name)) throw new Error('알 수 없는 효과음이에요.')
    if (!builtinCache.has(name)) builtinCache.set(name, fs.readFileSync(path.join(ASSETS, 'sounds', builtinSounds[name])))
    return builtinCache.get(name)
  })
  ipcMain.on('sound:error', (_e, info) => {
    if (!info || !['petting', 'talking'].includes(info.kind) || typeof info.message !== 'string') return
    settingsWin?.webContents.send('sound:error', { kind: info.kind, message: info.message.slice(0, 500) })
  })
  ipcMain.handle('settings:set', (_e, patch) => {
    // 'Claude Code 따라 하기'를 켜면 연결까지 한 번에 한다. 연결해야 다른 세션에서도 표정이 따라간다.
    let modError = null
    if (patch?.followClaudeCode === true && fs.existsSync(CLAUDE_HOME) && !modConnected()) {
      try { connectMod(true) } catch (err) { modError = String(err.message || err) }
    }
    applySettings(patch)
    return { ...settingsInfo(), modError }
  })
  ipcMain.handle('settings:reset', () => {
    const before = store.get()
    finishDrag(before)
    refresh(before, store.reset())
    return settingsInfo()
  })
  ipcMain.on('settings:clear-chat', clearChat)
  ipcMain.handle('mod:connect', (_e, on) => {
    let error = null
    try {
      connectMod(!!on)
    } catch (err) {
      error = String(err.message || err)
    }
    return { ...settingsInfo(), modError: error }
  })
}

// ── 개발용 ─────────────────────────────────────────────────────────────
// CLAU_DEBUG=<파일>: 지금 상태를 그 파일에 계속 적는다.
function debugDump() {
  if (!process.env.CLAU_DEBUG || !win) return
  const text = JSON.stringify({
    track,
    trackError,
    kind: tracker?.kind,
    wmScale,
    attached: isAttached(),
    visible: win.isVisible(),
    bounds: win.getBounds(),
    armed,
    tray: !!tray,
  })
  fs.writeFile(process.env.CLAU_DEBUG, text, () => {})
}

// CLAU_SHOT=<폴더>: 상태별 화면을 찍어 저장하고 끝낸다.
async function selfTest(dir) {
  const assert = require('node:assert/strict')
  const checks = []
  const check = (condition, label) => { assert.ok(condition, label); checks.push(label) }
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const js = code => win.webContents.executeJavaScript(code)
  const bjs = code => bubbleWin.webContents.executeJavaScript(code)
  const shot = async (name, target = win) => {
    const image = await target.webContents.capturePage()
    fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG())
    if (target === win) {
      console.log('shot', name, JSON.stringify(win.getBounds()), await js('petEl.dataset.eyes + "/" + petEl.dataset.mouth + " " + petEl.className'))
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  await wait(1500)
  await js('cc=null;setLocal(null);recompute()')
  // 연결하기·끊기가 Claude Code 설정 파일을 어떻게 바꾸는지 (가짜 HOME에서만 돌린다)
  if (process.env.CLAU_TRY_LINK) {
    connectMod(true)
    console.log('linked', modConnected(), fs.readFileSync(CLAUDE_SETTINGS, 'utf8'), fs.readdirSync(path.join(MOD_DIR, 'hooks')))
    connectMod(false)
    console.log('unlinked', modConnected(), fs.readFileSync(CLAUDE_SETTINGS, 'utf8'), fs.existsSync(MOD_DIR))
  }
  await shot('1-idle')
  await js('clearTimeout(blinkTimer); blink(1)')
  await wait(60)
  await shot('1-blink-closing')
  await wait(80)
  await shot('1-blink-closed')
  await wait(130)
  await shot('1-blink-opening')
  await wait(400)
  await js("setLocal('thinking')")
  await wait(300)
  await shot('2-thinking')
  await js("openBubble(); showWaiting()")
  await wait(450)
  await shot('3-waiting')
  await js("showAnswer('안녕, 나 클로야! Claude 창 한쪽에 살아.'); setLocal('talking')")
  await wait(700)
  await shot('3-talking-bubble')
  await js("setLocal('happy')")
  await wait(250)
  await shot('4-happy')
  await js("closeBubble(); setLocal('oops')")
  await wait(400)
  await shot('5-oops')
  await js("setLocal('sleeping')")
  await wait(1700)
  await shot('6-sleeping')
  await js("setLocal('working')")
  await wait(300)
  await shot('7-working')
  await js('setLocal(null); pat()')
  await wait(120)
  await shot('8-petted-a')
  await js('pat(); pat(); pat()')
  await wait(200)
  await shot('8-petted-b')
  await js('stopPetting(0)')
  await wait(200)
  await shot('9-pleased')
  await wait(1400)
  await js('onInput({ locked: true, armed: true })')
  await wait(300)
  await shot('10-locked-armed')
  await js('onInput({ locked: false, armed: true })')
  console.log('head zone', await js('JSON.stringify(headZone())'), 'buddy anim', await js("getComputedStyle(document.querySelector('.buddy-float')).animationName"))

  // Real pointer events exercise capture, drag IPC, held expression and cleanup.
  applySettings({ followClaudeCode: false, placement: 'free', position: { x: 300, y: 300 }, locked: false })
  await wait(100)
  const pet = petSize(store.get())
  // 창은 캐릭터보다 크다(회전 여유). 캐릭터가 그 안 어디에 있는지부터 구한다.
  const frame = win.getBounds()
  const stageAt = lastLayout.stage
  const px = Math.round(stageAt.left + pet.width * 0.56)
  const py = Math.round(stageAt.top + pet.height * 0.65)
  const at = (x, y) => ({ x, y, globalX: frame.x + x, globalY: frame.y + y })
  win.show()
  win.focus()
  await wait(80)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at(px, py) })
  win.webContents.sendInputEvent({ type: 'mouseDown', ...at(px, py), button: 'left', clickCount: 1 })
  await wait(30)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at(px + 30, py + 2), button: 'left' })
  await wait(100)
  console.log('drag check', await js('JSON.stringify({down,dragging,mode,eyes:petEl.dataset.eyes})'))
  check(await js('dragging && mode === "held" && petEl.dataset.eyes === "x"'), 'Dragging uses held state and X eyes')
  check(await js('imgs.eyes_x.tagName.toLowerCase() === "img" && imgs.eyes_x.src.endsWith("/assets/eyes_x.png")'), 'Held eyes use the original artwork')
  check(frame.width > pet.width && frame.height > pet.height, 'Window keeps transparent sway room around the character')
  await shot('held-x-eyes')
  const heldBounds = win.getBounds()
  win.webContents.sendInputEvent({ type: 'mouseUp', x: frame.x + px + 30 - heldBounds.x, y: frame.y + py + 2 - heldBounds.y, globalX: frame.x + px + 30, globalY: frame.y + py + 2, button: 'left', clickCount: 1 })
  await wait(1100)
  check(await js('!dragging && down === null && settle === null && bodyEl.style.transform === ""'), 'Releasing settles the tilt and clears held motion')
  check(win.getBounds().width === frame.width && win.getBounds().height === frame.height, 'Release never resizes the window')

  // 상반신: 창이 커도 다리는 보이지 않는다.
  applySettings({ view: 'bust', position: { x: 300, y: 300 } })
  await wait(150)
  check(lastLayout.stage.cut === lastLayout.stage.height && await js('getComputedStyle(stage).clipPath !== "none"'), 'Bust view hides the lower body inside the larger window')
  await shot('view-bust')

  // 자동: 바닥에 내려놓으면 같은 크기로 앉고(상반신), 들어 올리면 전신.
  const drag = (phase, dx = 0, dy = 0) => ipcMain.emit('pet:drag', {}, phase, dx, dy)
  const floor = screen.getPrimaryDisplay().workArea.y + screen.getPrimaryDisplay().workArea.height
  applySettings({ view: 'auto', seated: false, position: { x: 300, y: 200 } })
  await wait(150)
  const autoFrame = win.getBounds()
  const fullScale = await js('scale')
  check(!store.get().seated && lastLayout.shape.view === 'full' && lastLayout.stage.cut === undefined, 'Auto view shows the full body away from the floor')
  await shot('view-auto-full')
  drag('start')
  drag('move', 0, floor - 200)
  await wait(80)
  check(lastLayout.stage.cut > 0 && petPos.y === floor - petSize().seat, 'Dragging below the floor sinks the body and stops at the bust line')
  drag('end')
  await wait(SEAT_SLIDE_MS + 200)
  check(store.get().seated && lastLayout.shape.view === 'bust' && petPos.y + lastLayout.shape.height === floor && lastLayout.stage.cut === lastLayout.shape.height, 'Dropping on the floor seats the character as a bust, cut at the floor')
  check(Math.abs(await js('scale') - fullScale) < 1e-9, 'Seated bust keeps exactly the same drawing size as the full body')
  const seatedFrame = win.getBounds()
  check(seatedFrame.width === autoFrame.width && seatedFrame.height === autoFrame.height, 'Switching between full and bust never resizes the window')
  await shot('view-auto-seated')
  drag('start')
  drag('move', 0, -300)
  await wait(60)
  drag('end')
  await wait(200)
  check(!store.get().seated && lastLayout.shape.view === 'full' && lastLayout.stage.cut === undefined, 'Lifting the character off the floor shows the full body again')
  drag('start')
  drag('move', 0, floor - petPos.y - petSize().full - 6)
  drag('end')
  await wait(SEAT_SLIDE_MS + 200)
  check(store.get().seated, 'Dropping just above the floor also sits down')
  applySettings({ view: 'full', seated: false })
  await wait(80)

  applySettings({ chatEnabled: false, dragEnabled: false, petting: false })
  await wait(80)
  await js('openBubble()')
  check(!expanded && !bubbleWin?.isVisible(), 'Chat switch prevents opening bubble')
  applySettings({ chatEnabled: true, dragEnabled: true, petting: true })
  await wait(80)

  openSettings()
  await wait(1200)
  for (const tab of ['chat', 'look', 'place', 'lock', 'react', 'run']) {
    await settingsWin.webContents.executeJavaScript(`showTab(${JSON.stringify(tab)})`)
    await wait(250)
    await shot(`settings-${tab}`, settingsWin)
  }
  const settingsJs = code => settingsWin.webContents.executeJavaScript(code)
  await settingsJs(`appsInfo={supported:true,apps:[{kind:'x11',id:'test.editor',label:'Test Editor',windows:2}]};renderApps();el('targetAppSelect').value='x11:test.editor';el('targetAppSelect').dispatchEvent(new Event('change'))`)
  await settingsJs('saveQueue')
  check(store.get().targetAppSelection?.id === 'test.editor', 'Selecting a listed app persists stable identity')
  await settingsJs('appsInfo={supported:true,apps:[]};renderApps()')
  check(await settingsJs('el("targetAppSelect").selectedOptions[0].textContent.includes("저장됨")'), 'Saved app remains selected when its window closes')
  applySettings({ chatProvider: 'codex' })
  await wait(100)
  check(await settingsJs('[...el("providerList").children].map(i => i.dataset.id).join() === "codex,claude,groq" && el("providerList").firstElementChild.querySelector(".rank").textContent === "1"'), 'Choosing Codex first puts it at the top of the answer order')
  // 순서 목록: 화살표로 옮기기, 끌어서 옮기기, 칸을 눌러 설정 펼치기
  await settingsJs('el("providerList").querySelector("[data-id=groq] .up").click(); saveQueue')
  await wait(60)
  check(store.get().providers.map(p => p.id).join() === 'codex,groq,claude', 'Arrow buttons reorder the answer order and save it')
  await settingsJs('el("providerList").querySelector("[data-id=groq] .pswitch").click(); saveQueue')
  await wait(60)
  check(store.get().chatChain.join() === 'codex,groq,claude', 'Turning a provider on adds it to the answer chain in list order')
  await settingsJs('showTab("chat")')
  await wait(50)
  const listBox = await settingsJs('(() => { const r = el("providerList").querySelector("[data-id=claude] .grip").getBoundingClientRect(); const top = el("providerList").firstElementChild.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(top.top + 4) } })()')
  settingsWin.focus()
  settingsWin.webContents.sendInputEvent({ type: 'mouseMove', x: listBox.x, y: listBox.y })
  settingsWin.webContents.sendInputEvent({ type: 'mouseDown', x: listBox.x, y: listBox.y, button: 'left', clickCount: 1 })
  for (let y = listBox.y; y >= listBox.top; y -= 8) {
    settingsWin.webContents.sendInputEvent({ type: 'mouseMove', x: listBox.x, y, button: 'left' })
    await wait(16)
  }
  await shot('settings-order-dragging', settingsWin)
  settingsWin.webContents.sendInputEvent({ type: 'mouseUp', x: listBox.x, y: listBox.top, button: 'left', clickCount: 1 })
  await wait(120)
  await settingsJs('saveQueue')
  check(store.get().providers.map(p => p.id).join() === 'claude,codex,groq' && store.get().chatProvider === 'claude', 'Dragging a provider to the top makes it answer first')
  check(await settingsJs('!el("providerList").querySelector(".pitem.dragging") && el("claudeBody").hidden'), 'Finishing a drag neither leaves a lifted row nor opens its settings')
  // 진짜 마우스로 누른다(코드로 click()을 부르면 포인터 붙잡기 문제를 놓친다).
  const realClick = async selector => {
    const p = await settingsJs(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) } })()`)
    settingsWin.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    settingsWin.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await wait(30)
    settingsWin.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await wait(120)
  }
  await realClick('[data-id=codex] .pitem-open')
  check(await settingsJs('!el("codexBody").hidden && el("codexBody").contains(el("codexModelPick"))'), 'Clicking a provider row with the mouse opens its own settings')
  await realClick('#codexModelPick .picker-button')
  check(await settingsJs('!el("codexModelPick").querySelector(".picker-menu").hidden'), 'Clicking a model picker with the mouse opens the model list')
  await realClick('[data-id=codex] .pitem-open')
  check(await settingsJs('el("codexBody").hidden'), 'Clicking the row again folds its settings')
  await realClick('[data-id=codex] .pitem-open')
  // 모델 고르기: 받아 온 목록이 그대로 보이고, 누르면 저장된다.
  await settingsJs(`lists.codex={models:[{id:'gpt-test-a',label:'GPT Test A',note:'first'},{id:'gpt-test-b',label:'GPT Test B',note:'second'}],source:'account'};lists.groq={models:[{id:'openai/gpt-oss-120b',label:'gpt-oss-120b',note:'OpenAI'},{id:'test/groq-b',label:'groq-b',note:'Test'}],source:'account'};renderModels()`)
  check(await settingsJs('el("codexModelPick").querySelectorAll(".picker-item").length === 3 && el("groqModelPick").querySelectorAll(".picker-item").length === 2 && el("modelPick").querySelectorAll(".picker-item").length === info.models.length + 1'), 'Every provider shows a populated model list')
  check(await settingsJs('!el("codexModelPick").querySelector(".picker-button").disabled && el("codexModelPick").querySelector(".picker-name").textContent === "Codex 기본"'), 'Codex picker starts on the CLI default and is usable')
  await settingsJs('showTab("chat")')
  await settingsJs('el("codexModelPick").querySelector(".picker-button").click()')
  await wait(220)
  check(await settingsJs('!el("codexModelPick").querySelector(".picker-menu").hidden && document.activeElement.classList.contains("picker-item")'), 'Opening a model picker shows its list and focuses the current model')
  await settingsJs('showTab("chat")')
  await shot('settings-codex-models', settingsWin)
  await settingsJs('el("codexModelPick").querySelector("[data-id=gpt-test-b]").click();saveQueue')
  await wait(60)
  check(store.get().codexModel === 'gpt-test-b' && await settingsJs('el("codexModelPick").querySelector(".picker-menu").hidden && el("codexModelPick").querySelector(".picker-name").textContent === "GPT Test B"'), 'Picking a Codex model saves it and closes the list')
  await settingsJs('el("providerList").querySelector("[data-id=groq] .pitem-open").click()')
  await wait(60)
  await settingsJs('el("groqModelPick").querySelector(".picker-button").click()')
  await wait(220)
  await shot('settings-groq-models', settingsWin)
  await settingsJs('el("groqModelPick").querySelector("[data-id=\\"test/groq-b\\"]").click();saveQueue')
  await wait(60)
  check(store.get().groqModel === 'test/groq-b', 'Picking a Groq model saves it')
  applySettings({ chatProvider: 'groq' })
  await wait(100)
  check(store.get().chatChain[0] === 'groq' && await settingsJs('el("providerList").firstElementChild.dataset.id === "groq"'), 'Groq can be the first choice')
  applySettings({ chatProvider: 'codex', codexModel: '', groqModel: 'openai/gpt-oss-120b' })
  await wait(100)
  await settingsJs('showTab("chat")')
  await shot('settings-codex', settingsWin)
  // Native selection is stubbed only in this isolated test profile; decoding
  // still uses the real renderer AudioContext and IPC managed-file reader.
  const wavPath = path.join(dir, 'custom-effect.wav')
  const wav = Buffer.alloc(44 + 1600)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(1600, 40)
  for (let i = 0; i < 800; i++) wav.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), 44 + i * 2)
  fs.writeFileSync(wavPath, wav)
  const originalDialog = dialog.showOpenDialog
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wavPath] })
  try {
    await settingsJs('chooseSound("petting")')
    await settingsJs('saveQueue')
    check(store.get().pettingSound === 'custom' && !!store.get().pettingSoundFile, 'Custom sound file selection persists through native picker IPC')
    await settingsJs('previewSound.prepare("petting")')
    fs.unlinkSync(wavPath)
    const copied = await soundFiles.readFile(store.get().pettingSoundFile, app.getPath('userData'))
    check(copied.equals(wav), 'Imported sound still works after original file is deleted')
    await settingsJs('window.pet.setGroqKey("gsk_mock_for_local_tests_only_12345")')
    check(groqCredential.info().configured && !JSON.stringify(settingsInfo()).includes('gsk_mock'), 'Groq key IPC exposes status without returning secret')
    check(!fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8').includes('gsk_mock'), 'Groq key is never saved in general settings')
  } finally { dialog.showOpenDialog = originalDialog }
  // 앱에 든 녹음 소리가 실제로 풀린다(쓰다듬기 꺅, 글자마다 말소리, 채팅 소리).
  check(await settingsJs(`(async () => { const s = ClauSound.create(); s.configure({ ...info.cfg, pettingSound: 'squee', talkingSound: 'blip', soundEnabled: true, soundVolume: 30 }); await s.prepare('petting'); await s.prepare('talking'); await s.preview('chatResult'); for (let i = 0; i < 3; i++) await s.preview('petting'); const v = s.voices(); s.dispose(); return v.petting === 3 && v.chat === 1 })()`), 'Bundled recordings decode and rapid petting sounds overlap')
  await settingsJs('showTab("react")')
  await shot('settings-custom-sound', settingsWin)
  settingsWin.close()

  // Chat owns a different native surface. Capture every native pet visibility /
  // bounds event, so a transient resize or hide cannot pass a final-state check.
  check(await js('document.getElementById("lock") === null'), 'No lock badge is drawn over the character')
  const area = screen.getPrimaryDisplay().workArea
  for (const [label, position] of [
    ['top-left', { x: area.x, y: area.y }],
    ['top-right', { x: area.x + area.width - pet.width, y: area.y }],
    ['bottom-left', { x: area.x, y: area.y + area.height - pet.height }],
    ['bottom-right', { x: area.x + area.width - pet.width, y: area.y + area.height - pet.height }],
  ]) {
    applySettings({ position, placement: 'free', chatEnabled: true })
    await wait(80)
    const initial = win.getBounds()
    const nativeEvents = []
    const listeners = ['resize', 'move', 'hide', 'show'].map(event => {
      const listener = () => nativeEvents.push(event)
      win.on(event, listener)
      return [event, listener]
    })
    setChatOpen(true)
    await wait(60)
    check(await bjs('phase === "opening" || phase === "open"'), `${label} bubble starts opening at once`)
    await shot(`bubble-${label}-early`, bubbleWin)
    await wait(420)
    check(await bjs('phase === "open"') && bubbleWin.isVisible(), `${label} bubble finishes opening`)
    await shot(`bubble-${label}-open`, bubbleWin)
    assert.deepEqual(win.getBounds(), initial)
    setChatOpen(false)
    await wait(520)
    for (const [event, listener] of listeners) win.removeListener(event, listener)
    assert.deepEqual(win.getBounds(), initial)
    check(nativeEvents.length === 0 && !bubbleWin.isVisible(), `${label} open/close never moves, resizes, hides or shows character`)
  }

  // 대답은 한 글자씩 나타나므로 다 나타날 때까지 기다린다.
  const answerReady = async text => {
    for (let i = 0; i < 100 && await bjs(`answer.textContent !== ${JSON.stringify(text)}`); i++) await wait(30)
    return bjs(`answer.textContent === ${JSON.stringify(text)}`)
  }
  if (process.env.CLAU_TEST_CLI) {
    applySettings({ codexPath: process.env.CLAU_TEST_CLI, claudePath: process.env.CLAU_TEST_CLI, historyTurns: 8 })
    for (const provider of ['claude', 'codex']) {
      applySettings({ chatProvider: provider })
      await wait(80)
      setChatOpen(true)
      await wait(560)
      check(bubbleWin.isFocused() && await bjs('document.activeElement === input'), 'Chat input receives keyboard focus')
      const initial = win.getBounds()
      const nativeEvents = []
      const listeners = ['resize', 'move', 'hide', 'show'].map(event => {
        const listener = () => nativeEvents.push(event)
        win.on(event, listener)
        return [event, listener]
      })
      await bjs('input.value="test companion"; form.requestSubmit()')
      for (let i = 0; i < 100 && await bjs('busy'); i++) {
        assert.deepEqual(win.getBounds(), initial)
        check(win.isVisible(), `${provider} character stays visible while sending`)
        await wait(50)
      }
      for (const [event, listener] of listeners) win.removeListener(event, listener)
      check(nativeEvents.length === 0, `${provider} send/response never changes character native surface`)
      check(await answerReady(`Hello from ${provider}`) && await bjs('!busy'), `${provider} completes renderer to CLI chat`)
      await shot(`chat-${provider}`)
      await shot(`bubble-${provider}`, bubbleWin)
    }
    applySettings({ chatProvider: 'claude', claudeFallbackToCodex: true })
    chat.clearAvailability()
    await wait(80)
    await bjs('input.value="force fallback";form.requestSubmit()')
    for (let i = 0; i < 100 && await bjs('busy'); i++) await wait(50)
    check(await answerReady('Hello from codex') && await bjs('providerState.provider === "codex" && providerState.fallback'), 'Claude quota failure automatically completes through Codex')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('data: '+JSON.stringify({choices:[{delta:{content:'Hello from groq'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    try {
      applySettings({ groqFallbackEnabled: true })
      chat.clearAvailability()
      await wait(80)
      await bjs('input.value="force groq";form.requestSubmit()')
      for (let i = 0; i < 100 && await bjs('busy'); i++) await wait(50)
      check(await answerReady('Hello from groq') && await bjs('providerState.provider === "groq"'), 'Both unavailable CLIs automatically complete through Groq streaming')
      await shot('bubble-groq', bubbleWin)
    } finally { globalThis.fetch = originalFetch }
    await bjs('input.value="cancel me"; form.requestSubmit()')
    await wait(80)
    applySettings({ chatEnabled: false })
    await wait(340)
    check(running === null && !bubbleWin.isVisible() && await bjs('!busy'), 'Disabling chat cancels active process and closes bubble')
  }
  // Linux(X11)는 통과시킨 창으로 마우스 움직임을 넘겨주지 못해서, 캐릭터에 닿았는지 직접 살펴야 한다.
  check(process.platform === 'linux' ? inputTimer !== null : inputTimer === null, 'Unlocked pet polls the mouse only where the platform needs it')
  check(stateWatcher === null, 'Disabled Claude Code following uses no file watcher')
  win.webContents.send('pet:visibility', false)
  await wait(80)
  check(await js('!visible && stateTimer === null && heldFrame === null'), 'Hidden character stops state and physics timers')
  win.webContents.send('pet:visibility', true)
  fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify({ passed: checks.length, checks }, null, 2))
  console.log(`UI checks passed: ${checks.length}`)

  if (process.env.CLAU_ASK) {
    // 진짜로 질문을 보내 본다: 말풍선 → claude → 글자 단위 응답 → 표정.
    await js("setLocal(null); openBubble(); input.value = " + JSON.stringify(process.env.CLAU_ASK) + "; form.requestSubmit()")
    const seen = new Set()
    for (let i = 0; i < 300 && (await js('busy')); i++) {
      seen.add(await js('mode'))
      await wait(100)
    }
    await wait(200)
    await shot('11-answer')
    fs.writeFileSync(
      path.join(dir, 'answer.json'),
      JSON.stringify({ answer: await js('answer.textContent'), modesWhileBusy: [...seen], modeAfter: await js('mode') }, null, 1),
    )
  }
  app.exit(0)
}

// ── 시작과 끝 ──────────────────────────────────────────────────────────
/**
 * 이미 떠 있는 클로에게 명령줄로 말을 건다.
 *   clau            설정 창 열기 (고정 모드에서 손이 닿지 않을 때의 비상구이기도 하다)
 *   clau --hello    인사만 (Claude Code가 깨울 때)
 *   clau --unlock   고정 모드 끄기
 *   clau --update   새 버전이 있으면 받아서 바꾸기
 *   clau --quit     끄기
 *   clau --cleanup  지우기 전 정리: Claude Code 연결, 자동 실행, ~/.claude/clau 를 거둔다
 * 처음 켤 때 --settings 를 붙이면 설정 창도 같이 열린다.
 */
/**
 * 지우기 전에 클로가 이 컴퓨터에 걸어 둔 것을 거둔다: Claude Code 연결(settings.json의 경로 한 줄),
 * 컴퓨터를 켤 때 자동 실행, ~/.claude/clau. 설정 파일은 남긴다(지울지는 설치 도우미가 묻는다).
 */
function cleanup() {
  try { if (modConnected()) connectMod(false) } catch {}
  try { setAutostart(false) } catch {}
  try { fs.rmSync(CLAU_HOME, { recursive: true, force: true }) } catch {}
}

function onSecondLaunch(argv) {
  if (argv.includes('--cleanup')) { cleanup(); return app.quit() }
  if (argv.includes('--quit')) return app.quit()
  if (argv.includes('--unlock')) return applySettings({ locked: false })
  if (argv.includes('--hello')) return win?.webContents.send('pet:hello')
  if (argv.includes('--update')) return installUpdate()
  openSettings()
}

if (!app.requestSingleInstanceLock()) {
  app.quit() // 이미 떠 있다: 명령줄은 그쪽으로 넘어갔다
} else if (process.argv.includes('--quit')) {
  app.exit(0) // 꺼져 있는데 끄라고 했다
} else if (process.argv.includes('--cleanup')) {
  app.whenReady().then(() => { cleanup(); app.exit(0) }) // 창을 띄우지 않고 거두기만 한다
} else if (needsX11Restart || process.argv.includes('--detach')) {
  // 새로 띄우고 물러난다. --detach 는 부른 쪽(Claude Code)이 기다리지 않게 하려는 것.
  const args = process.argv.slice(1).filter(arg => arg !== '--detach')
  if (needsX11Restart) args.push(X11_FLAG)
  app.releaseSingleInstanceLock()
  app.relaunch({ args })
  app.exit(0)
} else {
  app.on('second-instance', (_e, argv) => onSecondLaunch(argv))
  app.whenReady().then(() => {
    store.init(app.getPath('userData'))
    groqCredential = credentials.create(app.getPath('userData'), safeStorage)
    layers = JSON.parse(fs.readFileSync(path.join(ASSETS, 'layers.json'), 'utf8'))
    wireIpc()
    startTracker()
    createPet()
    syncDock()
    syncTray()
    watchState()
    if (!TESTING) {
      writeAppInfo()
      // 연결해 둔 mod는 앱과 같은 버전으로 맞춰 둔다.
      try {
        if (modConnected()) copyMod()
      } catch {}
      if (process.argv.includes('--settings')) openSettings()
      if (process.argv.includes('--update')) installUpdate()
      else scheduleUpdateCheck()
    }
    if (TESTING) win.webContents.once('did-finish-load', () => selfTest(process.env.CLAU_SHOT).catch(error => { console.error(error); app.exit(1) }))
  })
  app.on('window-all-closed', () => app.quit())

  // 끝날 때 창 관리자에 올려 둔 스크립트를 내린다.
  let cleaned = false
  app.on('will-quit', e => {
    cancelChat()
    clearTimeout(inputTimer)
    clearTimeout(stateRefreshTimer)
    clearTimeout(updateTimer)
    clearInterval(lookTimer)
    stateWatcher?.close()
    if (cleaned || !tracker) return
    cleaned = true
    const pending = tracker.stop()
    if (pending && typeof pending.then === 'function') {
      e.preventDefault()
      Promise.race([pending, new Promise(r => setTimeout(r, 800))]).finally(() => app.quit())
    }
  })
}
