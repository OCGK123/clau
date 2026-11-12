// 클로(Clau): Claude 창 한쪽에 붙어 산다. 원하면 화면 위에 따로 떠 있을 수도 있다.
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('./settings-store')
const chat = require('./chat')
const runningApps = require('./running-apps')
const soundFiles = require('./sound-files')
const credentials = require('./credentials')
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
// 말풍선 상자(최대 340px) 둘레에 여유를 둔다: 등장할 때 살짝 부풀어 넘치는 모양과 그림자가 창 끝에 잘리지 않도록.
const BLUR_CLOSE_DELAY_MS = 80 // 포커스가 캐릭터 창으로 옮겨 가는 중인지 확인할 짧은 틈
const BUBBLE = { width: 384, height: 234 }
const HIDE_DELAY_MS = 200 // 포커스가 잠깐 비는 순간에 깜빡이지 않도록
const LOCK_DWELL_MS = 600 // 고정 모드: 이만큼 마우스를 올려 두면 우클릭을 받는다
const TESTING = !!process.env.CLAU_SHOT

let win = null
let settingsWin = null
let bubbleWin = null
let tray = null
let layers = null
let petPos = { x: 0, y: 0 } // 말풍선을 접었을 때 창의 왼쪽 위
let expanded = false
let bubbleClosing = false
let lastBubbleLayout = null
let lastLayout = null
let dragFrom = null
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
let stateWatcher = null
let stateRefreshTimer = null
let cachedState = null
let stateLoaded = false
const cliCache = new Map()

const clamp = (value, lo, hi) => Math.max(lo, Math.min(value, hi))

// ── 크기와 자리 ────────────────────────────────────────────────────────
/** 보여 줄 영역: 작은 친구를 숨기면 캐릭터만큼만. */
function viewRect(cfg) {
  return cfg.showBuddy || !layers.layers.base ? layers.view : layers.layers.base
}

function petSize(cfg) {
  const [, , vw, vh] = viewRect(cfg)
  const shownH = cfg.view === 'bust' ? vh * BUST : vh
  return { width: Math.max(40, Math.round((cfg.size * vw) / shownH)), height: cfg.size }
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
    y: Math.round(clamp(y, c.y, c.y + c.height - pet.height)),
  }
}

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

/** 접힌 창은 캐릭터 크기만큼, 펼친 창은 그 위에 말풍선 자리만큼 더. */
function applyBounds() {
  if (!win) return
  const cfg = store.get()
  const pet = petSize(cfg)
  const area = screen.getDisplayMatching({ ...petPos, ...pet }).workArea
  const art = { ...pet, artWidth: pet.width * 0.94, artTop: cfg.size * 0.06, artHeight: cfg.size * 0.94 / (cfg.view === 'bust' ? BUST : 1) }
  const next = windowLayout({ position: petPos, pet: art, bubble: BUBBLE, area, expanded: false, dragging: !!dragFrom, anchors: lastLayout?.stage })
  petPos = next.position
  if (JSON.stringify(next) !== JSON.stringify(lastLayout)) {
    lastLayout = next
    // Responsive anchors are applied before the native surface expands. In a
    // collapsed window the available space is zero, so changing them cannot move the pet.
    win.webContents.send('pet:layout', next)
  }
  const current = win.getBounds()
  if (['x', 'y', 'width', 'height'].some(key => current[key] !== next.bounds[key])) win.setBounds(next.bounds)
  placeBubble()
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
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
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
    if (expanded && wantVisible()) { me.show(); me.focus() }
    me.webContents.send('chat:visibility', { open: expanded, layout: chatLayout() })
  })
  // 말풍선이 열린 채로 빈 곳(다른 앱 창 등)을 누르면 닫는다. 캐릭터를 누른 경우는
  // 캐릭터 쪽 클릭이 열고 닫기를 맡으므로 여기서는 건드리지 않는다.
  me.on('blur', () => {
    setTimeout(() => {
      if (bubbleWin !== me || !expanded) return
      const focused = BrowserWindow.getFocusedWindow()
      if (focused === me || focused === win) return
      setChatOpen(false)
    }, BLUR_CLOSE_DELAY_MS)
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

function setChatOpen(on) {
  on = !!on && store.get().chatEnabled
  if (on) {
    expanded = true
    bubbleClosing = false
    createBubble()
    placeBubble()
    if (wantVisible() && !bubbleWin.webContents.isLoading()) { bubbleWin.show(); bubbleWin.focus() }
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
  if (!win || dragFrom) return
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
    pid: process.pid,
    dir: app.getPath('userData'),
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

// ── 고정 모드: 마우스를 받을지 말지 ─────────────────────────────────────
function cursorOverPet() {
  // Wayland에서는 앱이 화면 전체의 마우스 위치를 알 수 없어서, 창 관리자가 알려 준 값을 쓴다.
  if (tracker?.kind === 'kwin' && !trackError) return !!track.hover
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}

function syncInput() {
  clearTimeout(inputTimer)
  inputTimer = null
  if (!win) return
  const cfg = store.get()
  if (cfg.locked && win.isVisible() && !expanded && !menuOpen && tracker?.kind !== 'kwin') inputTimer = setTimeout(syncInput, 100)
  if (!cfg.locked || TESTING) {
    armed = true
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
  win.setIgnoreMouseEvents(!armed)
  win.webContents.send('pet:input', { locked: cfg.locked, armed })
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
  if (before.claudeFallbackToCodex !== cfg.claudeFallbackToCodex || before.groqFallbackEnabled !== cfg.groqFallbackEnabled) cancelChat(true)
  if (before.claudePath !== cfg.claudePath || before.model !== cfg.model) chat.clearAvailability()
  if (!cfg.chatEnabled) setChatOpen(false)
  if (before.followClaudeCode !== cfg.followClaudeCode) watchState()
  if (before.autostart !== cfg.autostart) setAutostart(cfg.autostart)
  if (before.historyTurns !== cfg.historyTurns) history = cfg.historyTurns ? history.slice(-cfg.historyTurns) : []
  if (before.wakeWithClaude !== cfg.wakeWithClaude) writeAppInfo()
  syncDock(before)
  setOnTop()
  place()
  syncVisibility()
  lastInput = ''
  syncInput()
  syncTray()
  win?.webContents.send('cfg', cfg)
  settingsWin?.webContents.send('cfg', cfg)
  bubbleWin?.webContents.send('cfg', cfg)
  sendClaudeCodeState()
  return cfg
}

function applySettings(patch) {
  const before = store.get()
  if (dragFrom && ['size', 'view', 'showBuddy', 'placement', 'targetAppSelection', 'attachPos', 'position', 'locked', 'dragEnabled'].some(key => Object.hasOwn(patch, key))) finishDrag(before)
  return refresh(before, store.set(patch))
}

function finishDrag(cfg = store.get()) {
  if (!dragFrom) return
  dragFrom = null
  const c = isAttached() ? claudeRect() : null
  if (c) store.set({ attachPos: toAttachPos(petPos, c, petSize(cfg)) })
  else store.set({ position: { ...petPos } })
  place()
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
          click: () => applySettings({ attachPos: store.DEFAULT_ATTACH, position: null }),
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
      label: '상반신만 보기',
      type: 'checkbox',
      checked: cfg.view === 'bust',
      click: item => applySettings({ view: item.checked ? 'bust' : 'full' }),
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
    const pet = petSize(cfg)
    const c = isAttached() ? claudeRect() : null
    if (phase === 'start') {
      dragFrom = { ...petPos }
      applyBounds()
    }
    else if (phase === 'move' && dragFrom) {
      petPos = { x: Math.round(dragFrom.x + dx), y: Math.round(dragFrom.y + dy) }
      if (c) {
        petPos.x = Math.round(clamp(petPos.x, c.x, c.x + c.width - pet.width))
        petPos.y = Math.round(clamp(petPos.y, c.y, c.y + c.height - pet.height))
      }
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
    return settingsInfo()
  })
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
  ipcMain.on('sound:error', (_e, info) => {
    if (!info || !['petting', 'talking'].includes(info.kind) || typeof info.message !== 'string') return
    settingsWin?.webContents.send('sound:error', { kind: info.kind, message: info.message.slice(0, 500) })
  })
  ipcMain.handle('settings:set', (_e, patch) => {
    applySettings(patch)
    return settingsInfo()
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
  const px = Math.round(pet.width * 0.56)
  const py = Math.round(pet.height * 0.65)
  win.show()
  win.focus()
  await wait(80)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py, globalX: 300 + px, globalY: 300 + py })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: px, y: py, globalX: 300 + px, globalY: 300 + py, button: 'left', clickCount: 1 })
  await wait(30)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: px + 30, y: py + 2, globalX: 330 + px, globalY: 302 + py, button: 'left' })
  await wait(100)
  console.log('drag check', await js('JSON.stringify({down,dragging,mode,eyes:petEl.dataset.eyes})'))
  check(await js('dragging && mode === "held" && petEl.dataset.eyes === "x"'), 'Dragging uses held state and X eyes')
  check(await js('imgs.eyes_x.tagName.toLowerCase() === "img" && imgs.eyes_x.src.endsWith("/assets/eyes_x.png")'), 'Held eyes use the original artwork')
  check(win.getBounds().width > pet.width, 'Held character receives transparent sway room')
  await shot('held-x-eyes')
  const heldBounds = win.getBounds()
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 330 + px - heldBounds.x, y: 302 + py - heldBounds.y, globalX: 330 + px, globalY: 302 + py, button: 'left', clickCount: 1 })
  await wait(100)
  check(await js('!dragging && down === null && bodyEl.style.transform === ""'), 'Releasing clears capture motion')
  check(win.getBounds().width === pet.width, 'Release restores normal window size')

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
  check(await settingsJs('!el("codexModel").closest(".row").hidden && el("claudeModelFields").hidden'), 'Codex selection reveals correct provider settings')
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
    const firstPath = await bjs('shellPath.getAttribute("d")')
    await shot(`morph-${label}-early`, bubbleWin)
    await wait(80)
    const middlePath = await bjs('shellPath.getAttribute("d")')
    await shot(`morph-${label}-middle`, bubbleWin)
    await wait(220)
    const finalPath = await bjs('shellPath.getAttribute("d")')
    check(firstPath !== finalPath && middlePath !== finalPath, `${label} morph changes actual Bézier path geometry`)
    assert.deepEqual(win.getBounds(), initial)
    setChatOpen(false)
    await wait(320)
    for (const [event, listener] of listeners) win.removeListener(event, listener)
    assert.deepEqual(win.getBounds(), initial)
    check(nativeEvents.length === 0 && !bubbleWin.isVisible(), `${label} open/close never moves, resizes, hides or shows character`)
  }

  if (process.env.CLAU_TEST_CLI) {
    applySettings({ codexPath: process.env.CLAU_TEST_CLI, claudePath: process.env.CLAU_TEST_CLI, historyTurns: 8 })
    for (const provider of ['claude', 'codex']) {
      applySettings({ chatProvider: provider })
      await wait(80)
      setChatOpen(true)
      await wait(320)
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
      check(await bjs(`!busy && answer.textContent === ${JSON.stringify('Hello from ')} + ${JSON.stringify(provider)}`), `${provider} completes renderer to CLI chat`)
      await shot(`chat-${provider}`)
      await shot(`bubble-${provider}`, bubbleWin)
    }
    applySettings({ chatProvider: 'claude', claudeFallbackToCodex: true })
    chat.clearAvailability()
    await wait(80)
    await bjs('input.value="force fallback";form.requestSubmit()')
    for (let i = 0; i < 100 && await bjs('busy'); i++) await wait(50)
    check(await bjs('answer.textContent === "Hello from codex" && providerState.provider === "codex" && providerState.fallback'), 'Claude quota failure automatically completes through Codex')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('data: '+JSON.stringify({choices:[{delta:{content:'Hello from groq'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    try {
      applySettings({ groqFallbackEnabled: true })
      chat.clearAvailability()
      await wait(80)
      await bjs('input.value="force groq";form.requestSubmit()')
      for (let i = 0; i < 100 && await bjs('busy'); i++) await wait(50)
      check(await bjs('answer.textContent === "Hello from groq" && providerState.provider === "groq"'), 'Both unavailable CLIs automatically complete through Groq streaming')
      await shot('bubble-groq', bubbleWin)
    } finally { globalThis.fetch = originalFetch }
    await bjs('input.value="cancel me"; form.requestSubmit()')
    await wait(80)
    applySettings({ chatEnabled: false })
    await wait(340)
    check(running === null && !bubbleWin.isVisible() && await bjs('!busy'), 'Disabling chat cancels active process and closes bubble')
  }
  check(inputTimer === null, 'Unlocked pet uses no mouse polling timer')
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
 *   clau --quit     끄기
 * 처음 켤 때 --settings 를 붙이면 설정 창도 같이 열린다.
 */
function onSecondLaunch(argv) {
  if (argv.includes('--quit')) return app.quit()
  if (argv.includes('--unlock')) return applySettings({ locked: false })
  if (argv.includes('--hello')) return win?.webContents.send('pet:hello')
  openSettings()
}

if (!app.requestSingleInstanceLock()) {
  app.quit() // 이미 떠 있다: 명령줄은 그쪽으로 넘어갔다
} else if (process.argv.includes('--quit')) {
  app.exit(0) // 꺼져 있는데 끄라고 했다
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
      // 연결해 둔 mod는 앱과 같은 판으로 맞춰 둔다.
      try {
        if (modConnected()) copyMod()
      } catch {}
      if (process.argv.includes('--settings')) openSettings()
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
