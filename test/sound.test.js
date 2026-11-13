const { test } = require('node:test')
const assert = require('node:assert/strict')
const { create, audibleEnd, BUILTIN } = require('../src/sound')

// 소리 장치 흉내: 디코딩한 버퍼와 재생 기록만 남긴다.
function fakeAudio() {
  const started = []
  class Ctx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
    resume() { this.state = 'running'; return Promise.resolve() }
    suspend() { this.state = 'suspended'; return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
    async decodeAudioData(bytes) {
      const name = Buffer.from(bytes).toString()
      if (name === 'broken') throw new Error('bad')
      // 앞 0.05초만 소리, 나머지는 무음인 1초짜리 소리
      const data = new Float32Array(1000)
      for (let i = 0; i < 50; i++) data[i] = 0.5
      return { name, duration: 1, sampleRate: 1000, numberOfChannels: 1, getChannelData: () => data }
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, stopped: false, start(at, offset, length) { source.length = length; started.push(source) }, stop() { source.stopped = true; source.onended?.() } }
      return source
    }
  }
  return { Ctx, started }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const cfg = extra => ({ soundEnabled: true, soundVolume: 50, pettingSound: 'squee', talkingSound: 'blip', chatSound: true, ...extra })

test('built-in recordings are the defaults: squee for petting, the bundled blip for talking', async () => {
  const { Ctx, started } = fakeAudio()
  const asked = []
  const sound = create({ AudioContext: Ctx, load: async name => { asked.push(name); return new TextEncoder().encode(name) } })
  sound.configure(cfg())
  await sound.pat()
  await sound.talk()
  assert.deepEqual(asked, ['squee', 'blip'])
  assert.deepEqual(started.map(s => s.buffer.name), ['squee', 'blip'])
  assert.equal(BUILTIN.blip, 'talk.mp3')
})

test('rapid pats overlap instead of cutting each other off, up to a cap', async () => {
  const { Ctx, started } = fakeAudio()
  const sound = create({ AudioContext: Ctx, load: async name => new TextEncoder().encode(name) })
  sound.configure(cfg())
  for (let i = 0; i < 4; i++) await sound.pat()
  assert.equal(started.length, 4)
  assert.equal(started.filter(s => s.stopped).length, 0)
  assert.equal(sound.voices().petting, 4)
  for (let i = 0; i < 20; i++) await sound.pat()
  assert.equal(sound.voices().petting, 10)
  assert.ok(started[0].stopped, 'the oldest voice makes room')
})

test('trailing silence is not played, so per-character talking stays light', async () => {
  const { Ctx, started } = fakeAudio()
  const sound = create({ AudioContext: Ctx, load: async name => new TextEncoder().encode(name) })
  sound.configure(cfg())
  await sound.talk()
  assert.ok(started[0].length < 0.1, `played ${started[0].length}s of a 1s file`)
  assert.ok(audibleEnd(started[0].buffer) < 0.1)
})

test('custom files, none, switches and volume are respected', async () => {
  const { Ctx, started } = fakeAudio()
  const asked = []
  const errors = []
  const sound = create({ AudioContext: Ctx, onError: e => errors.push(e), load: async name => { asked.push(name); return name.startsWith('custom:') ? { id: 'abc.mp3', bytes: new TextEncoder().encode('mine') } : new TextEncoder().encode(name) } })
  sound.configure(cfg({ pettingSound: 'custom', pettingSoundFile: { id: 'abc.mp3' }, talkingSound: 'none' }))
  await sound.pat()
  await sound.talk()
  assert.deepEqual(asked, ['custom:petting'])
  assert.equal(started[0].buffer.name, 'mine')
  sound.configure(cfg({ chatSound: false }))
  await sound.play('chatResult')
  assert.equal(started.length, 1)
  sound.configure(cfg({ soundEnabled: false }))
  await sound.pat()
  assert.equal(started.length, 1)
  await sound.preview('petting') // 듣기는 스위치와 상관없이
  assert.equal(started.length, 2)
  sound.configure(cfg({ pettingSound: 'custom', pettingSoundFile: { id: 'abc.mp3' } }))
  await assert.doesNotReject(sound.prepare('petting'))
  const bad = create({ AudioContext: Ctx, onError: e => errors.push(e), load: async () => ({ id: 'x.mp3', bytes: new TextEncoder().encode('broken') }) })
  bad.configure(cfg({ pettingSound: 'custom', pettingSoundFile: { id: 'x.mp3' } }))
  await assert.rejects(bad.prepare('petting'), /재생할 수 없어요/)
  await settle()
  assert.equal(errors.at(-1).kind, 'petting')
})

test('hiding stops every voice', async () => {
  const { Ctx, started } = fakeAudio()
  const sound = create({ AudioContext: Ctx, load: async name => new TextEncoder().encode(name) })
  sound.configure(cfg())
  await sound.pat()
  await sound.talk()
  sound.setVisible(false)
  assert.ok(started.every(s => s.stopped))
  await sound.pat()
  assert.equal(started.length, 2)
})
