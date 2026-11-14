const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { DEFAULTS } = require('../src/settings-store')

async function renderer() {
  let now = 0
  let id = 0
  const timers = new Map()
  const frames = new Map()
  const callbacks = {}
  const expansions = []
  const audioVisibility = []
  const audioStops = []
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase()
      this.dataset = {}
      this.style = { setProperty(key, value) { this[key] = value }, removeProperty(key) { delete this[key] } }
      this.children = []
      this.listeners = {}
      this.classes = new Set()
      this.classList = {
        add: value => this.classes.add(value), remove: value => this.classes.delete(value), contains: value => this.classes.has(value),
        toggle: (value, active) => { if (active ?? !this.classes.has(value)) this.classes.add(value); else this.classes.delete(value) },
      }
      this.value = ''
      this.textContent = ''
      this.hidden = false
      this.scrollHeight = 0
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) }
    get className() { return [...this.classes].join(' ') }
    setAttribute(key, value) { if (key === 'class') this.className = value; else this[key] = value }
    appendChild(child) { this.children.push(child) }
    addEventListener(key, fn) { this.listeners[key] = fn }
    querySelectorAll() { return [] }
    getAnimations() { return [] }
    animate(frames, options) { this.lastAnimation = { frames, options }; return { cancel() {} } }
    hasChildNodes() { return !!this.textContent || !!this.innerHTML || !!this.children.length }
    focus() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 184, height: 220 } }
  }
  const elements = Object.fromEntries(['stage', 'pet', 'mover', 'body', 'buddy', 'spinner', 'fx', 'bubble', 'answer', 'ask', 'q', 'send', 'cancel', 'closeBubble'].map(name => [name, new Element()]))
  elements.pet.dataset.eyes = 'open'
  elements.pet.className = 'mode-idle'
  elements.bubble.hidden = true
  elements.spinner.hidden = true
  const body = new Element()
  const document = { body, visibilityState: 'visible', getElementById: name => elements[name], createElement: name => new Element(name), createElementNS: (_namespace, name) => new Element(name), addEventListener() {}, getAnimations: () => [] }
  const pet = {
    init: () => Promise.resolve({ cfg: { ...DEFAULTS }, layers: JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/layers.json'), 'utf8')), bust: 0.69, ccState: null, visible: true }),
    expand: value => expansions.push(value), ask() {}, cancel() {}, menu() {}, drag() {},
  }
  for (const name of ['Cfg', 'Input', 'Hello', 'ClaudeCode', 'Delta', 'Done', 'Error', 'RateLimit', 'Cleared', 'Layout', 'Visibility', 'ChatVisibility', 'ChatStarted', 'ChatCancelled', 'ChatProvider', 'Look', 'Notice', 'Power']) pet[`on${name}`] = fn => { callbacks[name] = fn }
  const files = { played: [] }
  const audio = { pats: 0, talks: 0, configure() {}, unlock() {}, pat() { audio.pats++ }, talk() { audio.talks++ }, play: name => files.played.push(name), stop() { audioStops.push('all') }, stopTalk() { audioStops.push('talk') }, dispose() {}, setVisible: value => audioVisibility.push(value) }
  // 몸짓 엔진·이펙트·녹음 효과음은 각자 테스트가 따로 있다. 여기서는 호출 기록만 남긴다.
  const animator = { modes: [], paused: [], attach() {}, setUnit() {}, setCalm() {}, setMode: value => animator.modes.push(value), setPaused: value => animator.paused.push(value), restart() {}, bounce() {}, untilSquishEnd: () => 0 }
  const window = { pet, PetMotion: require('../src/pet-motion'), ClauSound: { create: () => audio }, PetAnimator: animator, PetFx: { attach() {}, setOff() {}, burst() {} }, addEventListener() {} }
  class ClockDate extends Date { static now() { return now } }
  const context = vm.createContext({ window, document, Date: ClockDate, performance: { now: () => now },
    setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { at: now + ms, fn }); return key }, clearTimeout: key => timers.delete(key),
    setInterval: () => { throw new Error('The pet must not poll while idle') },
    requestAnimationFrame: fn => { const key = ++id; frames.set(key, fn); return key }, cancelAnimationFrame: key => frames.delete(key),
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/pet.js'), 'utf8'), context)
  await Promise.resolve()
  const evaluate = source => vm.runInContext(source, context)
  function advance(ms) {
    const until = now + ms
    for (;;) {
      const next = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      timers.delete(next[0])
      next[1].fn()
    }
    now = until
  }
  function frame() { for (const [key, fn] of [...frames]) { frames.delete(key); fn(now) } }
  const geometry = { stage: { left: 78, top: 222, width: 184, height: 220, anchorX: 0.5, anchorY: 1 }, bubble: { left: 0, top: 0, width: 340, height: 210, originX: 170, originY: 210 } }
  return { evaluate, advance, frame, callbacks, elements, timers, frames, expansions, audioVisibility, audioStops, geometry, animator, files, audio }
}

test('idle uses only state deadlines, and hiding suspends every renderer timer and frame', async () => {
  const r = await renderer()
  assert.equal(r.timers.get(r.evaluate('stateTimer')).at, 180000)
  assert.ok([...r.timers.values()].every(task => task.at !== 500))
  r.callbacks.Visibility(false)
  assert.equal(r.timers.size, 0)
  assert.equal(r.frames.size, 0)
  assert.equal(r.audioVisibility.at(-1), false)
  r.callbacks.Visibility(true)
  assert.equal(r.audioVisibility.at(-1), true)
  assert.equal(r.evaluate('mode'), 'idle')
  assert.equal(r.timers.get(r.evaluate('stateTimer')).at, 180000)
})

test('transient expressions expire by elapsed time while hidden and resume without polling', async () => {
  const r = await renderer()
  r.evaluate("setLocal('happy', 2500)")
  r.callbacks.Visibility(false)
  assert.equal(r.timers.size, 0)
  r.advance(6000)
  r.callbacks.Visibility(true)
  assert.equal(r.evaluate('local'), null)
  assert.equal(r.evaluate('mode'), 'idle')
  assert.equal(r.timers.get(r.evaluate('stateTimer')).at, 182500)
})

test('petting keeps its existing linger and pleased durations with a single state timeout', async () => {
  const r = await renderer()
  r.evaluate('startPetting(); stopPetting()')
  assert.equal(r.evaluate('mode'), 'petted')
  r.advance(650)
  assert.equal(r.evaluate('mode'), 'pleased')
  assert.equal(r.timers.get(r.evaluate('stateTimer')).at, 1850)
  r.advance(1200)
  assert.equal(r.evaluate('mode'), 'idle')
  r.evaluate('startPetting(); stopPetting(0)')
  assert.equal(r.evaluate('mode'), 'pleased')
  r.advance(1200)
  assert.equal(r.evaluate('mode'), 'idle')
})

test('chat opening delegates to a separate window and never reveals or animates the pet dialog', async () => {
  const r = await renderer()
  r.callbacks.Layout(r.geometry)
  const left = r.elements.stage.style.left
  const top = r.elements.stage.style.top
  r.evaluate('openBubble()')
  assert.deepEqual(r.expansions, [true])
  assert.equal(r.elements.bubble.hidden, true)
  assert.equal(r.frames.size, 0)
  r.callbacks.ChatVisibility({ open: true })
  assert.equal(r.evaluate('bubbleOpen'), true)
  r.evaluate('closeBubble()')
  assert.deepEqual(r.expansions, [true, false])
  assert.equal(r.elements.stage.style.left, left)
  assert.equal(r.elements.stage.style.top, top)
  assert.equal(r.elements.bubble.hidden, true)
})

test('external chat lifecycle drives expressions without adding any pet window layout work', async () => {
  const r = await renderer()
  r.callbacks.ChatVisibility({ open: true })
  r.callbacks.ChatStarted()
  assert.equal(r.evaluate('busy'), true)
  assert.equal(r.evaluate('mode'), 'thinking')
  r.callbacks.Delta('응답')
  assert.equal(r.evaluate('mode'), 'talking')
  r.callbacks.Done('응답')
  assert.equal(r.evaluate('busy'), false)
  assert.equal(r.evaluate('mode'), 'talking')
  r.advance(500)
  assert.equal(r.evaluate('mode'), 'happy')
  assert.deepEqual(r.expansions, [])
  assert.equal(r.elements.bubble.hidden, true)
})

test('a visibility signal before settings arrive cannot access an uninitialized face', async () => {
  const r = await renderer()
  assert.doesNotThrow(() => r.evaluate('cfg = undefined; layers = undefined; visible = false; syncVisibility()'))
})


test('held and oops expressions use the original X bitmap at its original layer geometry', async () => {
  const r = await renderer()
  assert.equal(r.evaluate('imgs.eyes_x.tagName'), 'IMG')
  assert.equal(r.evaluate('imgs.eyes_x.src'), '../assets/eyes_x.png')
  for (const mode of ['held', 'oops']) {
    r.evaluate(`setMode('${mode}')`)
    assert.equal(r.elements.pet.dataset.eyes, 'x')
    assert.equal(r.evaluate('imgs[EYE_ROLE[petEl.dataset.eyes]] === imgs.eyes_x'), true)
    assert.equal(r.evaluate('imgs.eyes_x.style.left === `${(layers.layers.eyes_x[0] - viewRect()[0]) * scale}px`'), true)
    assert.equal(r.evaluate('imgs.eyes_x.style.top === `${(layers.layers.eyes_x[1] - viewRect()[1]) * scale}px`'), true)
    assert.equal(r.evaluate('imgs.eyes_x.style.width === `${layers.layers.eyes_x[2] * scale}px`'), true)
    assert.equal(r.evaluate('imgs.eyes_x.style.height === `${layers.layers.eyes_x[3] * scale}px`'), true)
  }
})

test('petting retains the original X bitmap and its 260ms pat animation', async () => {
  const r = await renderer()
  r.evaluate('pat()')
  assert.equal(r.evaluate('imgs.eyes_petted.tagName'), 'IMG')
  assert.equal(r.evaluate('imgs.eyes_petted.src'), '../assets/eyes_x.png')
  assert.equal(r.evaluate('imgs.eyes_petted.style.width === imgs.eyes_x.style.width && imgs.eyes_petted.style.left === imgs.eyes_x.style.left'), true)
  assert.equal(r.evaluate('imgs.eyes_petted.lastAnimation.options.duration'), 260)
  assert.equal(r.elements.pet.dataset.eyes, 'petted')
})


test('switching a limited chat to Codex or Groq clears the stale Claude rate limit', async () => {
  for (const provider of ['codex', 'groq']) {
    const r = await renderer()
    r.callbacks.RateLimit({ status: 'rejected', resetsAt: 100 })
    assert.equal(r.evaluate('mode'), 'sleeping')
    r.callbacks.ChatProvider({ provider, fallback: true })
    assert.equal(r.evaluate('limitUntil'), 0)
    assert.equal(r.evaluate('mode'), 'idle')
  }
})

test('adding any fallback to the answer order clears a previously stored Claude cooldown', async () => {
  for (const chain of [['claude', 'codex'], ['claude', 'groq'], ['claude', 'codex', 'groq']]) {
    const r = await renderer()
    r.callbacks.RateLimit({ status: 'rejected', resetsAt: 100 })
    r.callbacks.Cfg({ ...r.evaluate('cfg'), chatChain: chain })
    assert.equal(r.evaluate('limitUntil'), 0)
    assert.equal(r.evaluate('mode'), 'idle')
  }
})


test('a finished answer lets its sounds ring out, while cancel and clear stop all voices', async () => {
  const r = await renderer()
  r.callbacks.ChatVisibility({ open: true })
  r.callbacks.ChatStarted()
  r.callbacks.Delta('응답')
  r.callbacks.Done('응답')
  assert.equal(r.audioStops.length, 0)
  r.callbacks.ChatStarted()
  r.callbacks.ChatCancelled()
  assert.equal(r.audioStops.at(-1), 'all')
  r.callbacks.ChatStarted()
  r.callbacks.Cleared()
  assert.equal(r.audioStops.at(-1), 'all')
})

test('fallback transitions discard the old speaking beat and wait for the next provider', async () => {
  const r = await renderer()
  r.callbacks.ChatStarted()
  r.callbacks.Delta('첫 서비스의 일부 응답')
  assert.equal(r.evaluate('mode'), 'talking')
  r.callbacks.Delta('')
  assert.equal(r.evaluate('mode'), 'thinking')
  assert.equal(r.evaluate('speechStartedAt'), null)
  r.callbacks.ChatProvider({ provider: 'groq', fallback: true })
  assert.equal(r.evaluate('mode'), 'thinking')
  r.callbacks.Delta('새 서비스의 응답')
  assert.equal(r.evaluate('mode'), 'talking')
})

test('state changes drive the motion engine, hiding pauses it, and chat joy plays its sound', async () => {
  const r = await renderer()
  r.callbacks.ChatVisibility({ open: true })
  r.callbacks.ChatStarted()
  assert.equal(r.animator.modes.at(-1), 'thinking')
  assert.equal(r.elements.spinner.hidden, false)
  r.callbacks.Delta('응답')
  r.callbacks.Done('응답')
  r.advance(500)
  assert.equal(r.animator.modes.at(-1), 'happy')
  assert.deepEqual(r.files.played, ['chatHappy'])
  r.advance(200)
  assert.equal(r.elements.spinner.hidden, true)
  r.callbacks.Visibility(false)
  assert.equal(r.animator.paused.at(-1), true)
  r.callbacks.Visibility(true)
  assert.equal(r.animator.paused.at(-1), false)
})

test('dropping a tilted pet ends the drag at once and swings back to upright with a damped wobble', async () => {
  const r = await renderer()
  r.evaluate('globalThis.__drags = []; window.pet.drag = phase => globalThis.__drags.push(phase)')
  r.evaluate('dragging = true; heldAngle = 200')
  r.evaluate('settleThenEndDrag(true)')
  assert.equal(r.evaluate('JSON.stringify(globalThis.__drags)'), '["end"]', 'the window no longer resizes, so the drag ends immediately')
  // 첫 프레임은 가장 가까운 방향(-160도)에서 시작해 잦아든다
  r.frame()
  const first = r.evaluate('parseFloat(bodyEl.style.transform.replace("rotate(", ""))')
  assert.ok(first < -150 && first > -161, `starts the short way (${first})`)
  for (let i = 0; i < 80 && r.evaluate('settle !== null'); i++) { r.advance(16); r.frame() }
  assert.equal(r.evaluate('settle'), null, 'settles')
  assert.equal(r.evaluate('bodyEl.style.transform'), undefined)
  r.evaluate('finishSettle(); finishSettle()')
  assert.equal(r.evaluate('JSON.stringify(globalThis.__drags)'), '["end"]', 'no duplicate drag end')
})

test('rapid pats each play a petting sound, and the pet never talks over the chat bubble', async () => {
  const r = await renderer()
  r.evaluate('pat(); pat(); pat(); pat()')
  assert.equal(r.audio.pats, 4)
  r.callbacks.ChatVisibility({ open: true })
  r.callbacks.ChatStarted()
  r.callbacks.Delta('글자마다 소리는 말풍선이 낸다')
  r.advance(3000)
  assert.equal(r.audio.talks, 0)
})

test('eyes look toward the mouse within a small reach, and rest when the setting is off', async () => {
  const r = await renderer()
  r.callbacks.Layout({ stage: { left: 100, top: 100, width: 184, height: 220 }, shape: r.evaluate('currentShape()') })
  const style = r.elements.pet.style
  const px = value => Number(String(value).replace('px', ''))
  r.callbacks.Look({ x: 2000, y: 160 }) // 멀리 오른쪽
  assert.ok(px(style['--look-x']) > 2, `x ${style['--look-x']}`)
  assert.ok(px(style['--look-x']) <= 220 * 0.016 + 0.01, 'never leaves the face')
  r.callbacks.Look({ x: -2000, y: 2000 }) // 멀리 왼쪽 아래
  assert.ok(px(style['--look-x']) < 0 && px(style['--look-y']) > 0)
  r.callbacks.Cfg({ ...r.evaluate('cfg'), flip: true })
  r.callbacks.Look({ x: 2000, y: 160 })
  assert.ok(px(style['--look-x']) < 0, 'mirrored art looks the right way on screen')
  r.callbacks.Cfg({ ...r.evaluate('cfg'), flip: false, lookAtCursor: false })
  assert.equal(style['--look-x'], '0px')
  assert.equal(style['--look-y'], '0px')
})


test('dozing starts with a yawn, and waking up stretches first', async () => {
  const r = await renderer()
  r.advance(180000)
  assert.equal(r.evaluate('mode'), 'yawn')
  assert.equal(r.elements.pet.dataset.mouth, 'yawn')
  r.advance(2400)
  assert.equal(r.evaluate('mode'), 'dozing')
  r.evaluate('wake()')
  assert.equal(r.evaluate('mode'), 'stretch')
  r.advance(1100)
  assert.equal(r.evaluate('mode'), 'idle')
})

test('Claude Code waking a dozing pet stretches before thinking', async () => {
  const r = await renderer()
  r.advance(183000)
  assert.equal(r.evaluate('mode'), 'dozing')
  r.callbacks.ClaudeCode({ mode: 'thinking', at: r.evaluate('Date.now()') })
  assert.equal(r.evaluate('mode'), 'stretch')
  r.advance(1100)
  assert.equal(r.evaluate('mode'), 'thinking')
})

test('many pats in a row make her shy with a blush, and fast rubbing makes her giggle', async () => {
  const r = await renderer()
  for (let i = 0; i < 6; i++) r.evaluate('pat()')
  assert.equal(r.evaluate('mode'), 'petted')
  r.evaluate('pat()')
  assert.equal(r.evaluate('mode'), 'shy')
  assert.equal(r.elements.pet.dataset.blush, 'on')
  r.evaluate('stopPetting(0)')
  assert.equal(r.evaluate('mode'), 'pleased')
  assert.equal(r.elements.pet.dataset.blush, 'on', 'the blush lingers while pleased')
  r.advance(4000)
  assert.equal(r.evaluate('mode'), 'idle')
  assert.equal(r.elements.pet.dataset.blush, 'off')
  r.evaluate('startPetting(); giggleUntil = Date.now() + GIGGLE_MS; recompute()')
  assert.equal(r.evaluate('mode'), 'giggle')
  r.advance(500)
  assert.equal(r.evaluate('mode'), 'petted')
})

test('a Claude Code question surprises her, then she tilts her head until it is answered', async () => {
  const r = await renderer()
  r.callbacks.Notice({ kind: 'ask', on: true })
  assert.equal(r.evaluate('mode'), 'surprised')
  assert.equal(r.elements.pet.classes.has('eyes-wide'), true)
  r.advance(900)
  assert.equal(r.evaluate('mode'), 'asking')
  r.callbacks.Notice({ kind: 'ask', on: false })
  assert.equal(r.evaluate('mode'), 'idle')
  r.callbacks.Notice({ kind: 'done' })
  assert.equal(r.evaluate('mode'), 'happy')
})

test('coming back after a long absence greets with a hop, a short one does not', async () => {
  const r = await renderer()
  r.callbacks.Visibility(false)
  r.advance(30000)
  r.callbacks.Visibility(true)
  assert.equal(r.evaluate('mode'), 'idle')
  r.callbacks.Visibility(false)
  r.advance(130000)
  r.callbacks.Visibility(true)
  assert.equal(r.evaluate('mode'), 'greet')
  r.advance(1400)
  assert.equal(r.evaluate('mode'), 'idle')
})

test('dropping her after a hard swing makes her dizzy, a gentle carry does not', async () => {
  const r = await renderer()
  r.evaluate('window.pet.drag = () => {}')
  r.evaluate('dragging = true; swing = 100; settleThenEndDrag(true); dragging = false; recompute()')
  assert.equal(r.evaluate('mode'), 'idle')
  r.evaluate('dragging = true; swing = 900; settleThenEndDrag(true); dragging = false; recompute()')
  assert.equal(r.evaluate('mode'), 'dizzy')
  assert.equal(r.elements.pet.dataset.eyes, 'x')
  r.advance(2400)
  assert.equal(r.evaluate('mode'), 'idle')
})


test('battery changes keep idle breathing and the mouth pop, with both rendered by the shared loop', async () => {
  const r = await renderer()
  r.evaluate("globalThis.__ticks = new Map(); globalThis.__idle = []; globalThis.__power = []; window.PetAnimator.tick = (key, fn) => fn ? __ticks.set(key, fn) : __ticks.delete(key); window.PetAnimator.setIdleMotion = value => __idle.push(value); window.PetAnimator.setLowPower = value => __power.push(value)")
  r.callbacks.Power({ battery: true })
  assert.equal(r.evaluate('__idle.length'), 0, 'power changes never turn idle motion off')
  assert.equal(r.evaluate('__power.at(-1)'), true)
  r.evaluate("setLocal('talking'); mouthPop()")
  assert.equal(r.evaluate("__ticks.has('mouth-pop')"), true)
  assert.equal(r.evaluate('imgs.mouth_open.style.transform'), 'scale(0.82, 0.55)')
  r.advance(40)
  r.evaluate("__ticks.get('mouth-pop')(performance.now())")
  assert.notEqual(r.evaluate('imgs.mouth_open.style.transform'), 'scale(0.82, 0.55)')
  r.callbacks.Visibility(false)
  assert.equal(r.evaluate("__ticks.has('mouth-pop')"), false)
  assert.equal(r.evaluate('imgs.mouth_open.style.transform'), '')
  r.callbacks.Power({ battery: false })
  assert.equal(r.evaluate('__power.at(-1)'), false)
})

test('thinking selects the original face or the upward-looking pout with the same body motion and spinner', async () => {
  for (const [random, variant, eyes, mouth] of [[0.1, 'closed', 'closed', 'closed'], [0.9, 'up', 'open', 'sleep']]) {
    const r = await renderer()
    r.evaluate(`Math.random = () => ${random}; setLocal('thinking')`)
    assert.equal(r.elements.pet.dataset.thinking, variant)
    assert.equal(r.elements.pet.dataset.eyes, eyes)
    assert.equal(r.elements.pet.dataset.mouth, mouth)
    assert.equal(r.animator.modes.at(-1), 'thinking', 'both faces keep the existing thinking body animation')
    assert.equal(r.elements.spinner.hidden, false, 'both faces keep the existing spinner')
    if (variant === 'up') {
      assert.ok(Number(r.elements.pet.style['--look-y'].replace('px', '')) < -3, 'pupils visibly look up')
      assert.equal(r.elements.pet.style['--look-x'], '0px')
      assert.equal(r.evaluate('imgs.mouth_sleep.src'), '../assets/mouth_sleep.png', 'thinking uses the original Die.png mouth asset')
      r.callbacks.Look({ x: -2000, y: 3000 })
      assert.ok(Number(r.elements.pet.style['--look-y'].replace('px', '')) < -3, 'the thinking pose does not follow the mouse away')
    }
  }
})

test('the chosen thinking face survives state refresh, layout, flips, reduced motion and a short hide; the next thought chooses again', async () => {
  const r = await renderer()
  r.evaluate("Math.random = () => 0.9; setLocal('thinking'); Math.random = () => 0.1")
  const before = r.elements.pet.style['--look-y']
  r.callbacks.ClaudeCode({ mode: 'thinking', at: 0 })
  r.callbacks.Cfg({ ...r.evaluate('cfg'), flip: true, reduceMotion: true, lookAtCursor: false, size: 420 })
  r.callbacks.Layout({ ...r.geometry, shape: r.evaluate('currentShape()') })
  assert.equal(r.elements.pet.dataset.thinking, 'up')
  assert.equal(r.elements.pet.dataset.mouth, 'sleep')
  assert.equal(r.elements.pet.classes.has('flip'), true)
  assert.notEqual(r.elements.pet.style['--look-y'], before, 'the raised gaze scales with the character')
  assert.ok(Number(r.elements.pet.style['--look-y'].replace('px', '')) < 0, 'reduced motion keeps the expression as a static pose')
  r.callbacks.Visibility(false)
  r.advance(500)
  r.callbacks.Visibility(true)
  assert.equal(r.elements.pet.dataset.thinking, 'up')
  assert.equal(r.elements.pet.dataset.eyes, 'open')
  assert.equal(r.elements.pet.dataset.mouth, 'sleep')
  r.evaluate("setLocal('idle')")
  assert.equal(r.elements.pet.dataset.thinking, '')
  assert.equal(r.elements.pet.dataset.mouth, 'closed')
  assert.equal(r.elements.pet.style['--look-y'], '0px', 'leaving thinking releases the raised gaze')
  r.evaluate("setLocal('thinking')")
  assert.equal(r.elements.pet.dataset.thinking, 'closed', 'a new thinking transition samples the other face')
  assert.equal(r.elements.pet.dataset.eyes, 'closed')
  assert.equal(r.elements.pet.dataset.mouth, 'closed')
})
