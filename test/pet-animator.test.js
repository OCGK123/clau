const test = require('node:test')
const assert = require('node:assert/strict')

// 가짜 시계와 requestAnimationFrame: 프레임을 손으로 한 장씩 넘긴다.
let now = 0
const queue = []
const timers = new Map()
let timerId = 0
globalThis.performance = { now: () => now }
globalThis.requestAnimationFrame = fn => queue.push(fn)
globalThis.cancelAnimationFrame = () => {}
// 느린 움직임은 setTimeout으로 쉬었다가 다음 프레임을 부른다. 가짜 시계로 돌린다.
globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { at: now + ms, fn }); return timerId }
globalThis.clearTimeout = id => timers.delete(id)
const fireTimers = () => {
  for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.fn() }
}
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
    fireTimers()
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
  timers.clear()
  now += 16.7
  assert.equal(queue.length + timers.size, 0, 'no more frames while idle on battery')
  assert.equal(body.style.transform, '')
  PetAnimator.setIdleMotion(true)
  assert.ok(queue.length > 0, 'breathing resumes on AC power')
})

test('slow breathing wakes about 20 times a second, fast hops every frame', () => {
  PetAnimator.setMode('idle')
  run(1500)
  const count = () => {
    let n = 0
    const end = now + 2000
    while (now < end) {
      now += 16.7
      fireTimers()
      const fn = queue.shift()
      if (fn) { n++; fn(now) }
    }
    return n / 2
  }
  const slow = count()
  assert.ok(slow >= 12 && slow <= 24, `idle frames per second ${slow}`)
  PetAnimator.setMode('happy')
  const fast = count()
  assert.ok(fast > 45, `happy frames per second ${fast}`)
  PetAnimator.setLowPower(true)
  PetAnimator.setMode('idle')
  run(1500)
  const battery = count()
  assert.ok(battery <= 14, `battery idle frames per second ${battery}`)
  PetAnimator.setLowPower(false)
})

test('every new state starts and ends without a pop', () => {
  for (const mode of ['yawn', 'stretch', 'surprised', 'asking', 'shy', 'dizzy', 'greet', 'giggle', 'idle']) {
    PetAnimator.setMode(mode)
    const r = run(2600)
    assert.ok(r.jump < 0.06, `${mode}: max step ${r.jump}`)
  }
})

test('the face lags behind a hop and springs back (squishy follow-through)', () => {
  const faceNode = { style: {} }
  PetAnimator.attach(body, buddy, { face: faceNode })
  PetAnimator.setFaceAnchor(140)
  PetAnimator.setMode('happy')
  let moved = 0
  for (let i = 0; i < 60; i++) {
    run(17)
    const m = (faceNode.style.transform || '').match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)
    if (m) moved = Math.max(moved, Math.abs(Number(m[2])))
  }
  assert.ok(moved > 0.5, `face lags by ${moved}px`)
  PetAnimator.setMode('idle')
  run(4000)
  assert.ok(!faceNode.style.transform || /translate\((-?0\.0\d)px, (-?0\.0\d)px\)/.test(faceNode.style.transform) || faceNode.style.transform === '', `face rests (${faceNode.style.transform})`)
  PetAnimator.attach(body, buddy)
})

// Use an independent clock and the actual extra layers for shared-loop regressions.
function clockedAnimator(hz = 60, rafLag = 0) {
  const fs = require('node:fs')
  const vm = require('node:vm')
  let clock = 100
  let key = 0
  let requests = 0
  const frames = new Map()
  const pending = new Map()
  const context = {
    module: { exports: {} }, performance: { now: () => clock },
    requestAnimationFrame: fn => { requests++; frames.set(++key, fn); return key }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, ms) => { pending.set(++key, { at: clock + ms, fn }); return key }, clearTimeout: id => pending.delete(id),
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/pet-animator'), 'utf8'), context)
  const engine = context.module.exports
  const body = { style: {} }
  engine.attach(body, { style: {} }, { float: { style: {} }, face: { style: {} } })
  function advance(ms) {
    const end = clock + ms
    let lo = Infinity, hi = -Infinity
    while (clock < end) {
      clock += 1000 / hz
      for (const [id, task] of [...pending]) if (task.at <= clock) { pending.delete(id); task.fn() }
      for (const [id, fn] of [...frames]) { frames.delete(id); fn(clock - rafLag) }
      const y = scaleY(body)
      lo = Math.min(lo, y); hi = Math.max(hi, y)
    }
    return { lo, hi }
  }
  return { engine, body, advance, pending: () => frames.size + pending.size, requests: () => requests }
}

test('shared status tickers survive reduced-motion settings and pause while hidden', () => {
  const { engine, advance, pending } = clockedAnimator()
  let ticks = 0
  engine.setMode('thinking')
  engine.tick('spinner', () => { ticks++; return true }, 12)
  advance(500)
  engine.setCalm(true)
  const before = ticks
  advance(1000)
  assert.ok(ticks - before >= 10 && ticks - before <= 13, 'status continues at 12fps with a still body')
  engine.setCalm(true)
  const again = ticks
  advance(500)
  assert.ok(ticks > again, 'reapplying unchanged settings never freezes the ticker')
  engine.setPaused(true)
  const hidden = ticks
  advance(1000)
  assert.equal(ticks, hidden)
  assert.equal(pending(), 0)
  engine.setPaused(false)
  advance(500)
  assert.ok(ticks > hidden)
  engine.tick('spinner', null)
  advance(500)
  assert.equal(pending(), 0, 'no status or body work remains in reduced-motion mode')
})

test('adaptive battery cadence preserves breathing and respects drawing caps on 60Hz and 144Hz screens', () => {
  for (const hz of [60, 144]) {
    const { engine, advance } = clockedAnimator(hz)
    engine.setLowPower(true)
    const breathing = advance(8000)
    assert.ok(breathing.hi > 1.01 && breathing.lo < 0.995, `battery breathing remains visible at ${hz}Hz`)
    engine.setLowPower(false)
    engine.setMode('thinking')
    let ticks = 0
    engine.tick('measure', () => { ticks++; return true }, 1)
    advance(1000)
    ticks = 0
    advance(4000)
    assert.ok(ticks >= 90 && ticks <= 98, `24fps cap at ${hz}Hz (${ticks / 4}fps)`)
    engine.setLowPower(true)
    advance(1000)
    ticks = 0
    advance(4000)
    assert.ok(ticks >= 44 && ticks <= 50, `12fps cap on battery at ${hz}Hz (${ticks / 4}fps)`)
  }
})


test('stale compositor timestamps never turn the capped loop into a full-refresh rAF loop', () => {
  const { engine, advance, requests } = clockedAnimator(60, 14)
  engine.setMode('thinking')
  let ticks = 0
  engine.tick('count', () => { ticks++; return true }, 1)
  advance(1000)
  ticks = 0
  const before = requests()
  advance(4000)
  assert.ok(ticks >= 90 && ticks <= 98, `24fps with a rAF clock 14ms behind (${ticks / 4}fps)`)
  assert.ok(requests() - before <= 100, 'no extra rAF wakeups between capped drawings')
  engine.setLowPower(true)
  advance(1000)
  ticks = 0
  advance(4000)
  assert.ok(ticks >= 44 && ticks <= 50, `12fps with a stale compositor clock (${ticks / 4}fps)`)
})

test('both ordinary dozing and limited sleep show z marks, including reduced motion',()=>{const zs=[{style:{}},{style:{}},{style:{}}];PetAnimator.setPaused(false);PetAnimator.setCalm(false);PetAnimator.attach(body,buddy,{zs});for(const mode of ['dozing','sleeping']){PetAnimator.setMode(mode);run(800);assert.ok(zs.some(z=>Number(z.style.opacity)>0),mode)}PetAnimator.setCalm(true);PetAnimator.setMode('dozing');assert.ok(zs.every(z=>Number(z.style.opacity)>0));PetAnimator.setCalm(false)})
