// 렌더러 지킴이와 문제 기록.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const guard = require('../src/renderer-guard')
const { createProblemLog } = require('../src/problem-log')

function fakeWindow() {
  const me = new EventEmitter()
  me.webContents = new EventEmitter()
  me.destroyed = false
  me.reloads = 0
  me.isDestroyed = () => me.destroyed
  me.webContents.isDestroyed = () => me.destroyed
  me.webContents.reload = () => { me.reloads++; me.webContents.emit('did-finish-load') }
  return me
}

function fakeClock() {
  let t = 0, id = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id },
    clearTimeout: key => timers.delete(key),
    advance(ms) {
      const until = t + ms
      for (;;) {
        const next = [...timers].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        t = next[1].at; timers.delete(next[0]); next[1].fn()
      }
      t = until
    },
    size: () => timers.size,
  }
}

function setup() {
  const me = fakeWindow()
  const clock = fakeClock()
  const calls = { log: [], gone: 0, revived: 0, gaveUp: 0 }
  guard.guardRenderer(me, {
    name: 'pet', clock,
    log: line => calls.log.push(line),
    onGone: () => calls.gone++,
    onRevived: () => calls.revived++,
    onGiveUp: () => calls.gaveUp++,
  })
  return { me, clock, calls }
}

test('a crashed renderer is reloaded after a short pause and the window is set up again', () => {
  const { me, clock, calls } = setup()
  me.webContents.emit('did-finish-load') // 처음 불러온 것은 창을 만든 쪽 몫
  assert.equal(calls.revived, 0)
  me.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 })
  assert.equal(calls.gone, 1, 'emergency step runs at once')
  assert.equal(me.reloads, 0, 'does not reload in the same tick')
  clock.advance(guard.RELOAD_DELAY_MS)
  assert.equal(me.reloads, 1)
  assert.equal(calls.revived, 1)
  assert.match(calls.log[0], /pet: renderer gone \(crashed, exit 11\)/)
})

test('a window closing normally is not treated as a crash', () => {
  const { me, clock, calls } = setup()
  me.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  me.destroyed = true
  me.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  clock.advance(5000)
  assert.equal(me.reloads, 0)
  assert.equal(calls.gone, 0)
  assert.deepEqual(calls.log, [])
})

test('too many crashes in a minute give up instead of looping forever', () => {
  const { me, clock, calls } = setup()
  for (let i = 0; i <= guard.CRASH_LIMIT; i++) {
    me.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 })
    clock.advance(guard.RELOAD_DELAY_MS + 100)
  }
  assert.equal(me.reloads, guard.CRASH_LIMIT)
  assert.equal(calls.gaveUp, 1)
})

test('crashes spread over time keep being healed', () => {
  const { me, clock, calls } = setup()
  for (let i = 0; i < 6; i++) {
    me.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    clock.advance(guard.CRASH_WINDOW_MS / 2)
  }
  assert.equal(me.reloads, 6)
  assert.equal(calls.gaveUp, 0)
})

test('a hang that clears on its own is left alone; one that lasts is reloaded', () => {
  const { me, clock, calls } = setup()
  me.emit('unresponsive')
  clock.advance(guard.HANG_GRACE_MS / 2)
  me.emit('responsive')
  clock.advance(guard.HANG_GRACE_MS)
  assert.equal(me.reloads, 0)
  me.emit('unresponsive')
  me.emit('unresponsive') // 알림이 겹쳐도 한 번만 센다
  clock.advance(guard.HANG_GRACE_MS)
  assert.equal(me.reloads, 1)
  assert.equal(calls.revived, 1)
  assert.equal(clock.size(), 0)
})

test('closing the window cancels pending reloads', () => {
  const { me, clock } = setup()
  me.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  me.emit('closed')
  assert.equal(clock.size(), 0)
  clock.advance(10_000)
  assert.equal(me.reloads, 0)
})

test('the problem log appends timestamped lines and stays small', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clau-log-'))
  const log = createProblemLog(dir, { maxBytes: 2000, now: () => new Date('2026-11-14T00:00:00Z') })
  log.write('first problem\n')
  assert.equal(fs.readFileSync(log.file, 'utf8'), '2026-11-14T00:00:00.000Z first problem\n')
  for (let i = 0; i < 200; i++) log.write(`problem ${i} ${'x'.repeat(30)}`)
  const text = fs.readFileSync(log.file, 'utf8')
  assert.ok(text.length <= 2000 + 80, `trimmed to about the cap (${text.length})`)
  assert.match(text, /problem 199/, 'newest lines survive')
  assert.ok(text.split('\n').filter(Boolean).every(line => line.startsWith('2026-')), 'no cut lines')
  log.write('y'.repeat(10_000))
  assert.ok(fs.readFileSync(log.file, 'utf8').split('\n').every(line => line.length <= 2030), 'long lines are capped')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a problem log in a folder it cannot write to never throws', () => {
  // 폴더 자리에 파일이 있으면 만들 수도 쓸 수도 없다.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clau-log-')), 'file')
  fs.writeFileSync(blocker, '')
  const log = createProblemLog(path.join(blocker, 'logs'))
  assert.doesNotThrow(() => log.write('ignored'))
  fs.rmSync(path.dirname(blocker), { recursive: true, force: true })
})
