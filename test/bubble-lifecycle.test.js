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
      this.classList = { toggle: (key, active) => active ? this.classes.add(key) : this.classes.delete(key), remove: key => this.classes.delete(key), contains: key => this.classes.has(key) }
    }
    setAttribute(key, value) { this.attributes[key] = value }
    addEventListener(key, fn) { this.listeners[key] = fn }
    hasChildNodes() { return !!this.textContent || !!this.innerHTML }
    focus() {}
  }
  const elements = Object.fromEntries(['shell', 'shellPath', 'answer', 'ask', 'q', 'send', 'cancel', 'closeBubble'].map(name => [name, new Element()]))
  const document = { body: new Element(), visibilityState: hidden ? 'hidden' : 'visible', listeners: {}, getElementById: name => elements[name], addEventListener(key, fn) { this.listeners[key] = fn } }
  const pet = { expand: value => requests.push(value), bubbleClosed: () => closed++, ask: value => requests.push(value), cancel() {}, init: () => Promise.resolve({ cfg: { bubbleSeconds: 30, reduceMotion: false, chatEnabled: true }, chatOpen: false }) }
  for (const key of ['ChatVisibility', 'ChatLayout', 'ChatStarted', 'ChatCancelled', 'Delta', 'Done', 'Error', 'RateLimit', 'Cleared', 'Cfg']) pet[`on${key}`] = fn => { callbacks[key] = fn }
  class ClockDate extends Date { static now() { return now } }
  const context = vm.createContext({ window: { pet, BubbleShape: require('../src/bubble-shape'), addEventListener() {} }, document, Date: ClockDate, performance: { now: () => now },
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
  const layout = { width: 340, height: 224, originX: 170, originY: 222, side: 'above' }
  function open() { callbacks.ChatVisibility({ open: true, layout }) }
  function finishOpen() { open(); advance(260); frame() }
  return { evaluate, callbacks, elements, document, advance, frame, frames, timers, requests, layout, open, finishOpen, closed: () => closed }
}

test('the SVG path geometry itself morphs, and native hiding waits until closing completes', async () => {
  const r = await renderer()
  const initialClosed = r.closed()
  r.open()
  r.frame()
  const start = r.elements.shellPath.attributes.d
  r.advance(130)
  r.frame()
  const middle = r.elements.shellPath.attributes.d
  assert.notEqual(middle, start)
  assert.ok(r.evaluate('progress > 0 && progress < 1'))
  assert.equal(r.document.body.classList.contains('ready'), false)
  r.advance(130)
  r.frame()
  assert.notEqual(r.elements.shellPath.attributes.d, middle)
  assert.equal(r.document.body.classList.contains('ready'), true)
  assert.equal(r.frames.size, 0)
  r.callbacks.ChatVisibility({ open: false })
  r.advance(259)
  r.frame()
  assert.equal(r.closed(), initialClosed)
  r.advance(1)
  r.frame()
  assert.equal(r.closed(), initialClosed + 1)
  assert.equal(r.evaluate('progress'), 0)
})

test('reopening cancels an in-flight close without a stale hide acknowledgement', async () => {
  const r = await renderer()
  r.finishOpen()
  const initialClosed = r.closed()
  r.callbacks.ChatVisibility({ open: false })
  r.advance(130)
  r.frame()
  r.open()
  r.advance(260)
  r.frame()
  assert.equal(r.closed(), initialClosed)
  assert.equal(r.evaluate('progress'), 1)
  assert.equal(r.document.body.classList.contains('ready'), true)
})

test('a lazy hidden first open waits for native visibility before starting the real morph', async () => {
  const r = await renderer({ hidden: true })
  r.open()
  assert.equal(r.evaluate('progress'), 0)
  assert.equal(r.frames.size, 0)
  assert.equal(r.timers.size, 0)
  r.document.visibilityState = 'visible'
  r.document.listeners.visibilitychange()
  assert.equal(r.frames.size, 1)
  r.advance(130)
  r.frame()
  assert.ok(r.evaluate('progress > 0 && progress < 1'))
})

test('layout-only updates move tail geometry without replaying morph or hiding content', async () => {
  const r = await renderer()
  r.finishOpen()
  const before = r.elements.shellPath.attributes.d
  r.callbacks.ChatLayout({ ...r.layout, originX: 55 })
  assert.notEqual(r.elements.shellPath.attributes.d, before)
  assert.equal(r.frames.size, 0)
  assert.equal(r.document.body.classList.contains('ready'), true)
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
