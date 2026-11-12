const test = require('node:test')
const assert = require('node:assert/strict')
const { create } = require('../src/pet-sound')

function setup() {
  const oscillators = []
  let time = 0
  let contexts = 0
  const automation = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
  class AudioContext {
    constructor() { contexts++; this.state = 'running'; this.currentTime = 0 }
    createOscillator() {
      const node = { frequency: automation, connect() {}, disconnect() {}, start() {}, stops: 0, stop() { this.stops++ } }
      oscillators.push(node)
      return node
    }
    createGain() { return { gain: automation, connect() {}, disconnect() {} } }
    close() { return Promise.resolve() }
  }
  const audio = create({ AudioContext, now: () => time })
  return { audio, oscillators, contexts: () => contexts, advance: ms => { time += ms } }
}

const cfg = { soundEnabled: true, soundVolume: 35, pettingSound: 'chime', talkingSound: 'soft' }

test('audio is lazy, disabled by settings, and unavailable devices are optional', () => {
  const s = setup()
  s.audio.configure({ ...cfg, soundEnabled: false })
  s.audio.unlock()
  s.audio.pat()
  s.audio.talk()
  assert.equal(s.contexts(), 0)
  assert.equal(s.oscillators.length, 0)
  const unavailable = create({ AudioContext: null })
  unavailable.configure(cfg)
  assert.doesNotThrow(() => { unavailable.unlock(); unavailable.pat(); unavailable.talk(); unavailable.dispose() })
})

test('petting and talking presets can each be muted independently', () => {
  const s = setup()
  s.audio.configure({ ...cfg, pettingSound: 'none' })
  s.audio.unlock()
  s.audio.pat()
  assert.equal(s.oscillators.length, 0)
  s.audio.talk()
  assert.equal(s.oscillators.length, 1)
  s.audio.configure({ ...cfg, pettingSound: 'pop', talkingSound: 'none' })
  s.audio.pat()
  assert.equal(s.oscillators.length, 2)
  s.advance(200)
  s.audio.talk()
  assert.equal(s.oscillators.length, 2)
})

test('rapid streaming cannot flood sounds, and mute immediately stops existing voices', () => {
  const s = setup()
  s.audio.configure(cfg)
  s.audio.unlock()
  for (let i = 0; i < 100; i++) s.audio.talk()
  assert.equal(s.oscillators.length, 1)
  s.advance(110)
  s.audio.talk()
  assert.equal(s.oscillators.length, 2)
  s.audio.configure({ ...cfg, soundVolume: 0 })
  assert.ok(s.oscillators.every(node => node.stops === 2))
  s.advance(200)
  s.audio.pat()
  assert.equal(s.oscillators.length, 2)
})

test('hidden pets stop their voices and cannot generate sounds', () => {
  const s = setup()
  s.audio.configure(cfg)
  s.audio.unlock()
  s.audio.pat()
  assert.equal(s.oscillators.length, 2)
  s.audio.setVisible(false)
  assert.ok(s.oscillators.every(node => node.stops === 2))
  s.advance(1000)
  s.audio.pat()
  s.audio.talk()
  assert.equal(s.oscillators.length, 2)
  s.audio.setVisible(true)
  s.audio.talk()
  assert.equal(s.oscillators.length, 3)
})

test('the first gesture survives asynchronous audio unlock, and stopping cancels queued tones', async () => {
  let voices = 0
  let resolveResume
  const automation = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
  class SuspendedContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0 }
    resume() {
      if (!this.pending) this.pending = new Promise(resolve => { resolveResume = () => { this.state = 'running'; resolve() } })
      return this.pending
    }
    createOscillator() { voices++; return { frequency: automation, connect() {}, disconnect() {}, start() {}, stop() {} } }
    createGain() { return { gain: automation, connect() {}, disconnect() {} } }
  }
  const first = create({ AudioContext: SuspendedContext })
  first.configure({ ...cfg, pettingSound: 'pop' })
  first.unlock()
  first.pat()
  assert.equal(voices, 0)
  resolveResume()
  await Promise.resolve()
  assert.equal(voices, 1)

  const second = create({ AudioContext: SuspendedContext })
  second.configure(cfg)
  second.unlock()
  second.pat()
  second.stop()
  resolveResume()
  await Promise.resolve()
  assert.equal(voices, 1)

  const third = create({ AudioContext: SuspendedContext })
  third.configure(cfg)
  third.unlock()
  third.talk()
  third.stopSynth()
  resolveResume()
  await Promise.resolve()
  assert.equal(voices, 1)
})
