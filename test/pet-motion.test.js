const test = require('node:test')
const assert = require('node:assert/strict')
const { create } = require('../src/pet-motion')

function swing(distance) {
  const motion = create()
  motion.begin(0, 0)
  motion.move(distance, 16)
  const samples = []
  for (let at = 16; at <= 6000; at += 16) samples.push(motion.step(at))
  return samples
}

test('a stationary hand creates no artificial oscillation', () => {
  const motion = create()
  motion.begin(120, 0)
  for (let at = 16; at < 3000; at += 16) assert.equal(motion.step(at), 0)
})

test('stronger horizontal motion produces a larger swing in the expected direction', () => {
  const small = swing(4)
  const large = swing(12)
  assert.ok(large[0] > small[0] * 2.5)
  assert.ok(Math.max(...large.map(Math.abs)) > Math.max(...small.map(Math.abs)) * 2.5)
  assert.equal(Math.sign(large[0]), 1)
  assert.equal(Math.sign(swing(-12)[0]), -1)
})

test('strong motion can pass 24 degrees, 90 degrees, and multiple full turns without a ceiling', () => {
  const moderate = swing(50)
  const strong = swing(200)
  const spin = swing(1200)
  assert.ok(Math.max(...moderate.map(Math.abs)) > 24)
  assert.ok(Math.max(...strong.map(Math.abs)) > 90)
  assert.ok(Math.max(...spin.map(Math.abs)) > 720)
  assert.ok(Math.abs(spin.at(-1)) < 0.01)
  assert.ok(spin.every(Number.isFinite))
})

test('damped motion sleeps after settling and wakes on new hand input', () => {
  const motion = create()
  motion.begin(0, 0)
  motion.move(12, 16)
  assert.equal(motion.isSettled(), false)
  for (let at = 16; at < 10000; at += 16) motion.step(at)
  assert.equal(motion.isSettled(), true)
  motion.move(24, 10016)
  assert.equal(motion.isSettled(), false)
})

test('repeated vigorous input settles at the nearest full revolution without erasing accumulated turns', () => {
  const motion = create()
  let random = 60
  let x = 0
  const next = () => { random = (random * 1664525 + 1013904223) >>> 0; return random / 4294967296 }
  motion.begin(0, 0)
  let angle = 0
  let peak = 0
  for (let at = 16; at <= 1600; at += 16) {
    if (next() > 0.3) { x += (next() - 0.5) * 2000; motion.move(x, at) }
    angle = motion.step(at)
    peak = Math.max(peak, Math.abs(angle))
    assert.ok(Number.isFinite(angle))
  }
  for (let at = 1616; at <= 20000; at += 16) angle = motion.step(at)
  assert.ok(peak > 360)
  assert.ok(Math.abs(angle + 360) < 0.0001)
  assert.equal(motion.isSettled(), true)
  assert.equal(motion.step(30000), angle)
})

test('extreme pointer samples, frame gaps and backwards frames stay finite', () => {
  const motion = create({ length: NaN })
  motion.begin(0, 0)
  motion.move(Number.MAX_VALUE, 1)
  const first = motion.step(16)
  assert.ok(Number.isFinite(first))
  assert.equal(motion.step(8), first)
  motion.move(-Number.MAX_VALUE, 32)
  assert.ok(Number.isFinite(motion.step(1e9)))
  for (let at = 1e9 + 16; at < 1e9 + 20000; at += 16) assert.ok(Number.isFinite(motion.step(at)))
  assert.equal(motion.isSettled(), true)
})

test('release clears the spring and invalid or duplicate timestamps cannot inject motion', () => {
  const motion = create()
  motion.begin(0, 0)
  motion.move(1000, 0)
  motion.move(NaN, 20)
  assert.equal(motion.step(20), 0)
  motion.move(10, 32)
  assert.notEqual(motion.step(32), 0)
  motion.stop()
  assert.equal(motion.step(48), 0)
  motion.begin(9, 50)
  assert.equal(motion.step(66), 0)
})

test('natural swing stays near its soft limit and returns without bouncing, even when shaken hard', () => {
  const limitDeg = 0.6 * 180 / Math.PI
  const motion = create({ length: 150, limit: 0.6, smoothing: 0.55 })
  motion.begin(0, 0)
  let x = 0
  let peak = 0
  let at = 0
  for (; at < 1500; at += 16) {
    x += (Math.floor(at / 120) % 2 ? -1 : 1) * 60 // 좌우로 세게 흔들기
    motion.move(x, at)
    peak = Math.max(peak, Math.abs(motion.step(at)))
  }
  assert.ok(peak < limitDeg * 1.35, `peak ${peak.toFixed(1)}deg stays near ${limitDeg.toFixed(1)}deg`)
  // 손을 멈추면 한쪽으로 튕겨 나가지 않고 잦아든다
  let last = Infinity
  for (let end = at + 4000; at < end; at += 16) last = Math.abs(motion.step(at))
  assert.ok(last < 0.5, `settles (${last.toFixed(2)}deg)`)
})

test('smoothing softens the pickup jolt from a single fast pointer sample', () => {
  const jolt = smoothing => {
    const motion = create({ length: 150, smoothing })
    motion.begin(0, 0)
    motion.move(6, 4) // 끌기 시작 문턱을 넘는 첫 샘플(아주 짧은 시간에 몇 px)
    let peak = 0
    for (let at = 16; at < 600; at += 16) peak = Math.max(peak, Math.abs(motion.step(at)))
    return peak
  }
  assert.ok(jolt(0.55) < jolt(0) * 0.6, 'smoothed pickup is clearly gentler')
})
