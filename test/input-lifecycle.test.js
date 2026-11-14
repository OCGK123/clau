const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// Exercise the production input functions with TESTING=false: screenshot smoke
// tests deliberately force armed=true and cannot detect a click-through deadlock.
function inputHarness({ nativeWayland = false, trackerError = null, platform = 'linux' } = {}) {
  const source = fs.readFileSync(require.resolve('../src/main'), 'utf8')
  const start = source.indexOf('function wantsLook(')
  const end = source.indexOf('// ── 창 ─', start)
  let now = 1000, next = 0
  const timers = new Map()
  const ignores = []
  const sent = []
  const cfg = { locked: false, lookAtCursor: true, reduceMotion: false, chatEnabled: true, lockedChat: true, petting: true, lockedPetting: true }
  const state = {
    X11_FLAG: '--ozone-platform=x11', TESTING: false, LOCK_DWELL_MS: 600, INPUT_IDLE_POLL_MS: 700, petRendererDown: false,
    process: { platform, env: platform === 'linux' ? { XDG_SESSION_TYPE: 'wayland' } : {}, argv: nativeWayland ? [] : ['clau', '--ozone-platform=x11'] },
    tracker: { kind: platform === 'linux' ? 'kwin' : platform === 'darwin' ? 'mac' : 'windows', supported: true }, track: { hover: false, focused: true }, trackError: trackerError,
    rendererHover: false, pointerHeld: false, dragFrom: null, expanded: false, activeNotice: null, menuOpen: false,
    armed: true, hoverSince: 0, inputTimer: null, lookTimer: null, lastInput: '', lastLook: '', onBattery: false,
    point: { x: 0, y: 0 }, shown: true,
    lastLayout: { stage: { left: 40, top: 60, width: 600, height: 600, cut: 360 } },
    store: { get: () => cfg },
    screen: { getCursorScreenPoint: () => state.point },
    win: { getBounds: () => ({ x: 1500, y: 700, width: 720, height: 720 }), isVisible: () => state.shown,
      setIgnoreMouseEvents: (ignore, opts) => ignores.push({ ignore, forward: opts.forward }), webContents: { send: (...args) => sent.push(args) } },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.set(++next, { at: now + ms, fn }); return next }, clearTimeout: id => timers.delete(id),
  }
  vm.createContext(state)
  vm.runInContext(source.slice(start, end), state)
  function advance(ms) {
    const until = now + ms
    for (;;) {
      const pending = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!pending) break
      now = pending[1].at; timers.delete(pending[0]); pending[1].fn()
    }
    now = until
  }
  return { state, cfg, timers, ignores, sent, advance }
}

test('an unlocked KDE XWayland pet receives clicks without any KWin hover events', () => {
  const h = inputHarness()
  h.state.syncInput()
  assert.equal(h.ignores.at(-1).ignore, true, 'transparent margins pass clicks through')
  assert.equal(h.timers.size, 1, 'native X11 hit testing remains active despite a KWin geometry tracker')
  // Simulate moving onto a free pet while ignored; no renderer or KWin callback
  // can rescue the application in this scenario, only the real input poll can.
  h.state.point = { x: 1800, y: 900 }
  h.advance(450)
  assert.equal(h.state.armed, true)
  assert.equal(h.ignores.at(-1).ignore, false, 'the character receives the next click')
  assert.deepEqual(h.ignores.at(-1), { ignore: false, forward: true })
  h.state.point = { x: 100, y: 100 }
  h.advance(100)
  assert.equal(h.ignores.at(-1).ignore, true, 'moving away restores click-through margins')
})

test('KWin failure activates native pointer fallback and hidden pets stop polling', () => {
  const h = inputHarness({ nativeWayland: true, trackerError: 'compositor did not respond' })
  h.state.syncInput()
  assert.equal(h.timers.size, 1)
  h.state.point = { x: 1800, y: 900 }
  h.advance(450)
  assert.equal(h.ignores.at(-1).ignore, false)
  h.state.shown = false
  h.state.syncInput()
  assert.equal(h.timers.size, 0)
  assert.equal(h.ignores.at(-1).ignore, true)
})

test('native Wayland retains compositor hover while XWayland drag capture stays armed outside the pet', () => {
  const wayland = inputHarness({ nativeWayland: true })
  wayland.state.track.hover = true
  wayland.state.syncInput()
  assert.equal(wayland.ignores.at(-1).ignore, false)
  assert.equal(wayland.timers.size, 0, 'the native Wayland bridge remains event driven')
  const x11 = inputHarness()
  x11.state.pointerHeld = true
  x11.state.point = { x: 10, y: 10 }
  x11.state.syncInput()
  assert.equal(x11.ignores.at(-1).ignore, false, 'drag release is received outside the character')
  x11.state.pointerHeld = false
  x11.state.syncInput()
  assert.equal(x11.ignores.at(-1).ignore, true)
})

test('the visible cropped character receives input, and the area below its floor passes through', () => {
  const h = inputHarness()
  h.state.point = { x: 1800, y: 1100 }
  h.state.syncInput()
  assert.equal(h.ignores.at(-1).ignore, false)
  h.state.point = { x: 1800, y: 1140 }
  h.advance(100)
  assert.equal(h.ignores.at(-1).ignore, true)
  h.state.shown = false
  h.state.syncInput()
  assert.equal(h.timers.size, 0)
})


test('healthy KWin hover still works when the XWayland native pointer is stale', () => {
  const h = inputHarness()
  h.state.point = { x: 0, y: 0 }
  h.state.track.hover = true
  h.state.syncInput()
  assert.equal(h.ignores.at(-1).ignore, false)
  assert.equal(h.timers.size, 1, 'X11 fallback polling remains available if compositor hover stops')
  h.state.track.hover = false
  h.advance(450)
  assert.equal(h.ignores.at(-1).ignore, true)
})

function trackerHarness() {
  const source = fs.readFileSync(require.resolve('../src/main'), 'utf8')
  const start = source.indexOf('function startTracker()')
  const end = source.indexOf('// ── 눈이 마우스 따라보기', start)
  const calls = []
  const deadlines = []
  let options
  const state = {
    trackerGeneration: 0, tracker: null, trackError: null, track: {}, TESTING: false,
    store: { get: () => ({ placement: 'free' }) },
    trackers: { pick: () => 'kwin', create: input => { options = input; return { kind: 'kwin', stop() {} } } },
    process: { pid: 123 }, app: { getPath: () => '/tmp' },
    setTimeout: fn => deadlines.push(fn), wantsLook: () => false,
    setOnTop: () => calls.push('top'), place: () => calls.push('place'), syncVisibility: () => calls.push('visibility'),
    syncInput: () => calls.push('input'), syncLook: () => calls.push('look'),
    calibrate() {}, debugDump() {},
  }
  vm.createContext(state)
  vm.runInContext(source.slice(start, end), state)
  state.startTracker()
  return { state, calls, deadlines, options: () => options }
}

test('KWin failure and startup timeout immediately resync pointer input and eye tracking', () => {
  const failed = trackerHarness()
  failed.options().onFail(new Error('D-Bus service failed'))
  assert.equal(failed.state.trackError, 'D-Bus service failed')
  assert.ok(failed.calls.includes('input'), 'a visible free pet does not need another visibility event to recover')
  assert.ok(failed.calls.includes('look'))
  const silent = trackerHarness()
  silent.deadlines[0]()
  assert.equal(silent.state.trackError, '창 관리자가 응답하지 않아요.')
  assert.ok(silent.calls.includes('input'))
  assert.ok(silent.calls.includes('look'))
})

test('macOS and Windows still catch the cursor when forwarded mouse moves never arrive', () => {
  // 다른 앱(Claude)이 앞에 있으면 통과 중의 마우스 이동 전달이 오지 않을 수 있다.
  // 그래도 캐릭터에 닿으면 직접 살펴서 클릭을 받아야 한다(클릭 관통 버그).
  for (const platform of ['darwin', 'win32']) {
    const h = inputHarness({ platform })
    h.state.syncInput()
    assert.equal(h.ignores.at(-1).ignore, true, `${platform}: margins pass clicks through`)
    assert.equal(h.timers.size, 1, `${platform}: a pointer poll is scheduled`)
    h.state.point = { x: 1800, y: 900 }
    h.advance(450)
    assert.equal(h.ignores.at(-1).ignore, false, `${platform}: the character receives the click`)
  }
})

test('a far, still cursor is checked less often, and polling speeds up again once it moves', () => {
  const h = inputHarness({ platform: 'darwin' })
  h.state.point = { x: 0, y: 0 } // 캐릭터에서 멀리
  h.state.syncInput()
  const due = () => Math.min(...[...h.timers.values()].map(t => t.at))
  const first = due() - 1000
  assert.equal(first, 400, 'the first far poll uses the distance step')
  h.advance(first)
  assert.equal(due() - 1400, 700, 'a still far cursor backs off')
  h.state.point = { x: 1700, y: 760 } // 캐릭터 바로 옆으로 움직였다
  h.advance(700)
  assert.ok(due() - 2100 <= 120, 'a moving cursor near the pet is polled quickly again')
})

test('while the pet renderer is down the window passes every click through and stops polling', () => {
  const h = inputHarness({ platform: 'darwin' })
  h.state.point = { x: 1800, y: 900 }
  h.state.syncInput()
  assert.equal(h.ignores.at(-1).ignore, false)
  h.state.petRendererDown = true
  h.state.syncInput()
  assert.equal(h.ignores.at(-1).ignore, true, 'an invisible window never blocks clicks')
  assert.equal(h.timers.size, 0, 'no pointer polling while the character cannot be seen')
})
