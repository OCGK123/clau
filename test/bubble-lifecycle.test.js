const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function renderer({ hidden = false } = {}) {
  let now = 0
  let id = 0
  let closed = 0
  const frames = new Map()
  const timers = new Map()
  const callbacks = {}
  const requests = []
  class Element {
    constructor() {
      this.classes = new Set()
      this.listeners = {}
      this.attributes = {}
      this.value = ''
      this.textContent = ''
      this.scrollHeight = 0
      this.vars = {}
      this.style = { setProperty: (key, value) => { this.vars[key] = value } }
      this.classList = { toggle: (key, active) => active ? this.classes.add(key) : this.classes.delete(key), remove: key => this.classes.delete(key), contains: key => this.classes.has(key) }
    }
    setAttribute(key, value) { this.attributes[key] = value }
    addEventListener(key, fn) { this.listeners[key] = fn }
    hasChildNodes() { return !!this.textContent || !!this.innerHTML }
    focus() {}
  }
  const elements = Object.fromEntries(['dialog', 'answer', 'ask', 'q', 'send', 'cancel', 'closeBubble'].map(name => [name, new Element()]))
  const document = { body: new Element(), visibilityState: hidden ? 'hidden' : 'visible', listeners: {}, getElementById: name => elements[name], addEventListener(key, fn) { this.listeners[key] = fn } }
  const pet = { expand: value => requests.push(value), bubbleClosed: () => closed++, ask: value => requests.push(value), cancel() {}, init: () => Promise.resolve({ cfg: { bubbleSeconds: 30, reduceMotion: false, chatEnabled: true }, chatOpen: false }) }
  for (const key of ['ChatVisibility', 'ChatLayout', 'ChatStarted', 'ChatCancelled', 'Delta', 'Done', 'Error', 'RateLimit', 'Cleared', 'Cfg']) pet[`on${key}`] = fn => { callbacks[key] = fn }
  class ClockDate extends Date { static now() { return now } }
  const played = []
  const ClauSound = { create: () => ({ configure() {}, setVisible() {}, stop() {}, stopTalk() {}, talk: () => played.push('talk'), play: name => played.push(name) }) }
  const context = vm.createContext({ window: { pet, ClauSound, addEventListener() {} }, document, Date: ClockDate, performance: { now: () => now },
    setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { at: now + delay, fn }); return key }, clearTimeout: key => timers.delete(key),
    requestAnimationFrame: fn => { const key = ++id; frames.set(key, fn); return key }, cancelAnimationFrame: key => frames.delete(key),
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/bubble.js'), 'utf8'), context)
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
  const layout = { width: 384, height: 248, originX: 192, originY: 246, side: 'above' }
  function open() { callbacks.ChatVisibility({ open: true, layout }) }
  function finishOpen() { open(); advance(460) }
  return { evaluate, callbacks, elements, document, advance, frame, frames, timers, requests, layout, open, finishOpen, played, closed: () => closed }
}

test('the bubble pops open from the tail, and native hiding waits until closing completes', async () => {
  const r = await renderer()
  const initialClosed = r.closed()
  r.open()
  assert.equal(r.evaluate('phase'), 'opening')
  assert.equal(r.elements.dialog.classList.contains('opening'), true)
  assert.equal(r.document.body.classList.contains('shown'), true)
  assert.equal(r.document.body.classList.contains('ready'), false)
  r.advance(460)
  assert.equal(r.evaluate('phase'), 'open')
  assert.equal(r.document.body.classList.contains('ready'), true)
  r.callbacks.ChatVisibility({ open: false })
  assert.equal(r.elements.dialog.classList.contains('closing'), true)
  r.advance(239)
  assert.equal(r.closed(), initialClosed)
  r.advance(1)
  assert.equal(r.closed(), initialClosed + 1)
  assert.equal(r.evaluate('phase'), 'closed')
  assert.equal(r.document.body.classList.contains('shown'), false)
})

test('reopening cancels an in-flight close without a stale hide acknowledgement', async () => {
  const r = await renderer()
  r.finishOpen()
  const initialClosed = r.closed()
  r.callbacks.ChatVisibility({ open: false })
  r.advance(120)
  r.open()
  r.advance(460)
  assert.equal(r.closed(), initialClosed)
  assert.equal(r.evaluate('phase'), 'open')
  assert.equal(r.document.body.classList.contains('ready'), true)
})

test('a lazy hidden first open waits for native visibility before starting the animation', async () => {
  const r = await renderer({ hidden: true })
  r.open()
  assert.equal(r.evaluate('phase'), 'closed')
  assert.equal(r.timers.size, 0)
  r.document.visibilityState = 'visible'
  r.document.listeners.visibilitychange()
  assert.equal(r.evaluate('phase'), 'opening')
})

test('layout-only updates move the tail without replaying the animation or hiding content', async () => {
  const r = await renderer()
  r.finishOpen()
  const before = r.elements.dialog.vars['--tail-x']
  r.callbacks.ChatLayout({ ...r.layout, originX: 55 })
  assert.notEqual(r.elements.dialog.vars['--tail-x'], before)
  assert.equal(r.evaluate('phase'), 'open')
  assert.equal(r.document.body.classList.contains('ready'), true)
})

test('chat sounds play once each: open, send, first reply, close', async () => {
  const r = await renderer()
  r.evaluate("configure({ bubbleSeconds: 30, reduceMotion: false, chatEnabled: true, soundEnabled: true, soundVolume: 50, chatSound: true })")
  r.finishOpen()
  r.elements.q.value = '안녕'
  r.elements.ask.listeners.submit({ preventDefault() {}, isComposing: false })
  r.callbacks.Delta('안')
  r.callbacks.Delta('안녕!')
  r.callbacks.Done('안녕! 반가워.')
  r.callbacks.ChatVisibility({ open: false })
  assert.deepEqual(r.played, ['chatOpen', 'chatEnter', 'chatResult', 'chatClose'])
})

test('auto-close waits for inactivity, preserves drafts, and never closes on a slow final answer', async () => {
  const r = await renderer()
  r.finishOpen()
  r.callbacks.ChatStarted()
  r.advance(45000)
  assert.equal(r.requests.length, 0)
  r.callbacks.Done('오래 기다렸지?')
  assert.equal(r.requests.length, 0)
  r.advance(29000)
  r.elements.q.value = '아직 쓰는 중'
  r.elements.q.listeners.input()
  r.advance(5000)
  assert.equal(r.requests.length, 0)
  r.elements.q.value = ''
  r.elements.q.listeners.input()
  r.advance(30000)
  assert.deepEqual(r.requests, [false])
})

test('hidden chat does zero frame work and streaming keeps its latest complete text', async () => {
  const r = await renderer()
  r.finishOpen()
  r.callbacks.ChatStarted()
  r.callbacks.Delta('첫')
  r.callbacks.Delta('첫 번째 답변')
  assert.equal(r.frames.size, 1)
  r.frame()
  r.advance(1000)
  r.frame()
  assert.equal(r.elements.answer.textContent, '첫 번째 답변')
  r.document.visibilityState = 'hidden'
  r.document.listeners.visibilitychange()
  r.callbacks.Delta('첫 번째 답변이에요.')
  assert.equal(r.frames.size, 0)
  assert.equal(r.timers.size, 0)
  r.document.visibilityState = 'visible'
  r.document.listeners.visibilitychange()
  assert.equal(r.elements.answer.textContent, '첫 번째 답변이에요.')
})

test('answers appear one character at a time with a talking sound per character', async () => {
  const r = await renderer()
  r.finishOpen()
  r.callbacks.ChatStarted()
  r.callbacks.Delta('안녕 클로')
  const seen = []
  for (let i = 0; i < 12; i++) { r.frame(); seen.push(r.elements.answer.textContent); r.advance(30) }
  assert.equal(r.elements.answer.textContent, '안녕 클로')
  // 한 번에 다 나오지 않고 앞에서부터 늘어난다.
  assert.ok(seen.includes('안') && seen.includes('안녕'))
  for (const [i, text] of seen.entries()) if (i) assert.ok(text.startsWith(seen[i - 1]))
  // 공백을 뺀 글자 수만큼 말소리.
  assert.equal(r.played.filter(name => name === 'talk').length, 4)
  // 다른 서비스로 넘어가며 앞의 글자를 버리면 처음부터 다시 나타난다.
  r.callbacks.Delta('')
  r.callbacks.Delta('새 대답')
  r.advance(1000)
  r.frame()
  assert.equal(r.elements.answer.textContent, '새 대답')
})
