const test = require('node:test')
const assert = require('node:assert/strict')
const { create } = require('../src/pet-sound')

const ID = `${'a'.repeat(64)}.wav`
const OTHER = `${'b'.repeat(64)}.wav`
const base = { soundEnabled: true, soundVolume: 35, pettingSound: 'custom', talkingSound: 'custom', pettingSoundFile: { id: ID, name: 'pat.wav' }, talkingSoundFile: { id: ID, name: 'talk.wav' } }
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup(options = {}) {
  let time = 0
  let loads = 0
  let decodes = 0
  let contexts = 0
  let decodeBytes
  const sources = []
  const oscillators = []
  const errors = []
  class AudioContext {
    constructor() { contexts++; this.state = 'running'; this.currentTime = 0 }
    async decodeAudioData(bytes) {
      decodes++
      decodeBytes = bytes
      if (options.decode) return options.decode(bytes)
      return { duration: 3, numberOfChannels: 1 }
    }
    createBufferSource() {
      const source = { starts: [], stops: 0, connect() {}, disconnect() {}, start(...args) { this.starts.push(args) }, stop() { this.stops++; this.onended?.() }, finish() { this.onended?.() } }
      sources.push(source)
      return source
    }
    createOscillator() {
      const automation = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
      const oscillator = { frequency: automation, stops: 0, connect() {}, disconnect() {}, start() {}, stop() { this.stops++ } }
      oscillators.push(oscillator)
      return oscillator
    }
    createGain() {
      const gain = { value: null, setValueAtTime(value) { this.value = value }, exponentialRampToValueAtTime() {} }
      return { gain, connect() {}, disconnect() {} }
    }
    async resume() { this.state = 'running' }
    async suspend() { this.state = 'suspended' }
    async close() { this.state = 'closed' }
  }
  const audio = create({ AudioContext, now: () => time, loader: kind => {
    loads++
    return options.loader ? options.loader(kind) : Promise.resolve({ id: ID, bytes: new Uint8Array([1, 2, 3, 4]) })
  }, onError: error => errors.push(error) })
  audio.configure(base)
  return { audio, sources, oscillators, errors, advance: ms => { time += ms }, loads: () => loads, decodes: () => decodes, contexts: () => contexts, bytes: () => decodeBytes }
}

test('custom audio is lazy and prepare reads and decodes a selection only once', async () => {
  const s = setup()
  assert.equal(s.contexts(), 0)
  assert.equal(s.loads(), 0)
  await s.audio.prepare('petting')
  await s.audio.prepare('petting')
  await s.audio.prepare('talking')
  assert.equal(s.loads(), 1)
  assert.equal(s.decodes(), 1)
  assert.equal(s.sources.length, 0)
})

test('custom one-shots play their complete sample and repeated events cannot overlap a kind', async () => {
  const s = setup()
  s.audio.pat()
  await flush()
  assert.equal(s.sources.length, 1)
  const pat = s.sources[0]
  assert.deepEqual(pat.starts, [[0]])
  assert.equal(pat.loop, false)
  assert.equal(pat.stops, 0)
  s.advance(500)
  s.audio.pat()
  s.audio.talk()
  await flush()
  assert.equal(s.sources.length, 2)
  s.advance(500)
  s.audio.talk()
  await flush()
  assert.equal(s.sources.length, 2)
  pat.finish()
  s.advance(500)
  s.audio.pat()
  await flush()
  assert.equal(s.sources.length, 3)
  assert.equal(s.loads(), 1)
  assert.equal(s.decodes(), 1)
})

test('mute, hiding, reset and source changes stop custom voices immediately', async () => {
  const s = setup()
  s.audio.talk()
  await flush()
  s.audio.configure({ ...base, soundVolume: 0 })
  assert.equal(s.sources[0].stops, 1)
  s.advance(200)
  s.audio.pat()
  await flush()
  assert.equal(s.sources.length, 1)
  s.audio.configure(base)
  s.audio.pat()
  await flush()
  s.audio.setVisible(false)
  assert.equal(s.sources[1].stops, 1)
  s.audio.setVisible(true)
  s.advance(200)
  s.audio.pat()
  await flush()
  s.audio.configure({ ...base, pettingSound: 'chime', pettingSoundFile: null })
  assert.equal(s.sources[2].stops, 1)
  s.audio.configure(base)
  s.audio.talk()
  await flush()
  s.audio.configure({})
  assert.equal(s.sources[3].stops, 1)
})

test('stopping while a custom file is loading prevents a stale sample from starting', async () => {
  let resolveLoad
  const s = setup({ loader: () => new Promise(resolve => { resolveLoad = resolve }) })
  s.audio.pat()
  await flush()
  s.audio.stop()
  resolveLoad({ id: ID, bytes: new Uint8Array([1, 2]) })
  await flush()
  assert.equal(s.sources.length, 0)
  assert.equal(s.errors.length, 0)
})

test('changing a selection during decoding prevents the former sample from playing', async () => {
  let resolveDecode
  const s = setup({ decode: () => new Promise(resolve => { resolveDecode = resolve }) })
  s.audio.talk()
  await flush()
  s.audio.configure({ ...base, talkingSoundFile: { id: OTHER, name: 'new.wav' } })
  resolveDecode({ duration: 3 })
  await flush()
  assert.equal(s.sources.length, 0)
  assert.equal(s.errors.length, 0)
})

test('failed automatic reads are cached and reported once, while explicit prepare can retry a repair', async () => {
  let repaired = false
  const s = setup({ loader: async () => {
    if (!repaired) throw new Error('저장한 효과음 파일을 찾지 못했어요. 설정에서 파일을 다시 선택해 주세요.')
    return { id: ID, bytes: new Uint8Array([1, 2]) }
  } })
  s.audio.pat()
  await flush()
  s.advance(200)
  s.audio.pat()
  await flush()
  assert.equal(s.loads(), 1)
  assert.equal(s.errors.length, 1)
  assert.equal(s.errors[0].kind, 'petting')
  assert.match(s.errors[0].message, /다시 선택/)
  repaired = true
  await s.audio.prepare('petting')
  s.advance(200)
  s.audio.pat()
  await flush()
  assert.equal(s.loads(), 2)
  assert.equal(s.sources.length, 1)
})

test('unsupported codecs reject preview with an actionable decode error', async () => {
  const s = setup({ decode: async () => { throw new Error('EncodingError') } })
  await assert.rejects(s.audio.prepare('petting'), /재생할 수 없어요.*WAV·MP3/)
  assert.equal(s.sources.length, 0)
})

test('IPC typed-array slices decode only their selected byte range', async () => {
  const bytes = new Uint8Array([99, 1, 2, 3, 88])
  const s = setup({ loader: async () => ({ id: ID, bytes: bytes.subarray(1, 4) }) })
  await s.audio.prepare('petting')
  assert.deepEqual([...new Uint8Array(s.bytes())], [1, 2, 3])
})

test('finishing synthesized speech preserves full custom one-shots already playing', async () => {
  const s = setup()
  s.audio.configure({ ...base, talkingSound: 'soft' })
  s.audio.unlock()
  s.audio.pat()
  await flush()
  s.audio.talk()
  assert.equal(s.sources.length, 1)
  assert.equal(s.oscillators.length, 1)
  s.audio.stopSynth()
  assert.equal(s.oscillators[0].stops, 2)
  assert.equal(s.sources[0].stops, 0)
})

test('finishing synthesized speech does not invalidate a custom sample still loading', async () => {
  let resolveLoad
  const s = setup({ loader: () => new Promise(resolve => { resolveLoad = resolve }) })
  s.audio.pat()
  await flush()
  s.audio.stopSynth()
  resolveLoad({ id: ID, bytes: new Uint8Array([1, 2]) })
  await flush()
  assert.equal(s.sources.length, 1)
  assert.equal(s.sources[0].stops, 0)
})
