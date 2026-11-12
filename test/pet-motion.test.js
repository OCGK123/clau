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

test('sway damps after stopping and large movements stay bounded', () => {
  const samples = swing(20000)
  assert.ok(Math.max(...samples.map(Math.abs)) <= 0.42 * 180 / Math.PI + 0.0001)
  assert.ok(Math.abs(samples.at(-1)) < 0.001)
  const motion = create()
  motion.begin(0, 0)
  motion.move(12, 16)
  assert.equal(motion.isSettled(), false)
  for (let at = 16; at < 10000; at += 16) motion.step(at)
  assert.equal(motion.isSettled(), true)
  motion.move(24, 10016)
  assert.equal(motion.isSettled(), false)
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
