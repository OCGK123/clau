const test = require('node:test')
const assert = require('node:assert/strict')

// 가짜 시계와 requestAnimationFrame: 프레임을 손으로 한 장씩 넘긴다.
let now = 0
const queue = []
globalThis.performance = { now: () => now }
globalThis.requestAnimationFrame = fn => queue.push(fn)
globalThis.cancelAnimationFrame = () => {}
const PetAnimator = require('../src/pet-animator')

const body = { style: {} }
const buddy = { style: {} }
PetAnimator.attach(body, buddy)
PetAnimator.setUnit(2)

const scaleY = node => {
  const m = (node.style.transform || '').match(/scale\(([\d.]+), ([\d.]+)\)/)
  return m ? Number(m[2]) : 1
}
/** ms만큼 프레임을 돌리고, 한 프레임 사이 가장 큰 세로 크기 변화(툭 튐 지표)와 범위를 돌려준다. */
function run(ms, node = body) {
  let prev = scaleY(node)
  let jump = 0
  let lo = Infinity
  let hi = -Infinity
  for (const end = now + ms; now < end;) {
    now += 16.7
    const fn = queue.shift()
    if (fn) fn(now)
    const v = scaleY(node)
    jump = Math.max(jump, Math.abs(v - prev))
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
    prev = v
  }
  return { jump, lo, hi }
}

test('idle breathes gently without sudden twitches', () => {
  const r = run(8000)
  assert.ok(r.hi > 1.01 && r.lo < 0.995, 'visible breathing range')
  assert.ok(r.jump < 0.01, `no twitch (max step ${r.jump})`)
})

test('every state change blends from the current pose instead of popping', () => {
  for (const mode of ['thinking', 'talking', 'working', 'happy', 'idle', 'petted', 'pleased', 'oops', 'sleeping', 'idle']) {
    PetAnimator.setMode(mode)
    const r = run(mode === 'petted' ? 400 : 1200)
    assert.ok(r.jump < 0.06, `${mode}: max step ${r.jump}`)
  }
})

test('restart replays the petting squish from its first frame on every pat', () => {
  PetAnimator.setMode('petted')
  run(200)
  for (let i = 0; i < 3; i++) {
    PetAnimator.restart()
    const r = run(160)
    assert.ok(r.lo < 0.92, `pat ${i} squishes again (lowest ${r.lo})`)
  }
})

test('the buddy moves with the pet in idle', () => {
  PetAnimator.setMode('idle')
  const r = run(4000, buddy)
  assert.ok(r.hi - r.lo > 0.03, 'buddy squishes along')
})

test('pausing stops the frame loop', () => {
  PetAnimator.setPaused(true)
  queue.length = 0
  PetAnimator.setMode('happy')
  assert.equal(queue.length, 0)
  PetAnimator.setPaused(false)
  assert.ok(queue.length > 0)
})

test('on battery the idle breathing stops smoothly and the loop sleeps', () => {
  PetAnimator.setMode('idle')
  run(1000)
  PetAnimator.setIdleMotion(false)
  run(600)
  queue.length = 0
  now += 16.7
  assert.equal(queue.length, 0, 'no more frames while idle on battery')
  assert.equal(body.style.transform, '')
  PetAnimator.setIdleMotion(true)
  assert.ok(queue.length > 0, 'breathing resumes on AC power')
})
