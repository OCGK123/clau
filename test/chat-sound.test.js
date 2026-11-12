const test = require('node:test')
const assert = require('node:assert/strict')
const { create } = require('../src/chat-sound')

function fakeAudio() {
  const played = []
  class Audio {
    constructor(src) { this.src = src; this.volume = 1; this.currentTime = 0 }
    play() { played.push(this.src.split('/').pop()); return Promise.resolve() }
    pause() {}
  }
  return { Audio, played }
}

const on = { soundEnabled: true, soundVolume: 50, pettingSound: 'squee', chatSound: true }

test('chat sounds follow the master switch, volume and the chat toggle', () => {
  const { Audio, played } = fakeAudio()
  const sound = create({ Audio })
  sound.configure({ ...on, soundEnabled: false })
  sound.play('chatOpen')
  sound.configure({ ...on, soundVolume: 0 })
  sound.play('chatOpen')
  sound.configure({ ...on, chatSound: false })
  sound.play('chatOpen')
  assert.deepEqual(played, [])
  sound.configure(on)
  sound.play('chatOpen')
  sound.play('chatEnter')
  sound.play('chatResult')
  sound.play('chatClose')
  sound.play('chatHappy')
  assert.deepEqual(played, ['chat-open.mp3', 'chat-enter.mp3', 'chat-result.mp3', 'chat-close.mp3', 'chat-happy.wav'])
})

test('squee plays only when it is the chosen petting sound', () => {
  const { Audio, played } = fakeAudio()
  const sound = create({ Audio })
  sound.configure({ ...on, pettingSound: 'chime' })
  sound.play('squee')
  sound.configure(on)
  sound.play('squee')
  assert.deepEqual(played, ['squee.mp3'])
})

test('rapid pats can overlap and hidden windows stay silent', () => {
  const { Audio, played } = fakeAudio()
  const sound = create({ Audio })
  sound.configure(on)
  for (let i = 0; i < 5; i++) sound.play('squee')
  assert.equal(played.length, 5)
  sound.setVisible(false)
  sound.play('chatOpen')
  assert.equal(played.length, 5)
})

test('preview ignores the switches so settings can audition a sound', () => {
  const { Audio, played } = fakeAudio()
  const sound = create({ Audio })
  sound.configure({ soundEnabled: false, soundVolume: 40 })
  sound.preview('chatOpen')
  assert.deepEqual(played, ['chat-open.mp3'])
})
