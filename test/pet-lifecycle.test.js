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
  for (const name of ['Cfg', 'Input', 'Hello', 'ClaudeCode', 'Delta', 'Done', 'Error', 'RateLimit', 'Cleared', 'Layout', 'Visibility', 'ChatVisibility', 'ChatStarted', 'ChatCancelled', 'ChatProvider']) pet[`on${name}`] = fn => { callbacks[name] = fn }
  const audio = { configure() {}, unlock() {}, pat() {}, talk() {}, stop() { audioStops.push('all') }, stopSynth() { audioStops.push('synth') }, dispose() {}, setVisible: value => audioVisibility.push(value) }
  // 몸짓 엔진·이펙트·녹음 효과음은 각자 테스트가 따로 있다. 여기서는 호출 기록만 남긴다.
  const animator = { modes: [], paused: [], attach() {}, setUnit() {}, setCalm() {}, setMode: value => animator.modes.push(value), setPaused: value => animator.paused.push(value), restart() {}, bounce() {}, untilSquishEnd: () => 0 }
  const files = { played: [], configure() {}, setVisible() {}, play: name => files.played.push(name), stop() {} }
  const window = { pet, PetMotion: require('../src/pet-motion'), PetSound: { create: () => audio }, PetAnimator: animator, PetFx: { attach() {}, setOff() {}, burst() {} }, ChatSound: { create: () => files }, addEventListener() {} }
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
  return { evaluate, advance, frame, callbacks, elements, timers, frames, expansions, audioVisibility, audioStops, geometry, animator, files }
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

test('enabling either fallback route clears a previously stored Claude cooldown', async () => {
  for (const key of ['claudeFallbackToCodex', 'groqFallbackEnabled']) {
    const r = await renderer()
    r.callbacks.RateLimit({ status: 'rejected', resetsAt: 100 })
    r.callbacks.Cfg({ ...r.evaluate('cfg'), [key]: true })
    assert.equal(r.evaluate('limitUntil'), 0)
    assert.equal(r.evaluate('mode'), 'idle')
  }
})


test('successful chat completion keeps custom one-shots, while cancel and clear stop all voices', async () => {
  const r = await renderer()
  r.callbacks.ChatVisibility({ open: true })
  r.callbacks.ChatStarted()
  r.callbacks.Delta('응답')
  r.callbacks.Done('응답')
  assert.equal(r.audioStops.at(-1), 'synth')
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
