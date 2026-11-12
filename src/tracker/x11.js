// X11: one sleeping property subscription replaces five root-query processes
// per second. Geometry keeps its original 200ms cadence while the pet is shown.
const { execFile, spawn } = require('node:child_process')
const { matches, parseXClass } = require('./identity')

function start({ target, pid, showWhen = 'focused', onState, onFail }) {
  let stopped = false
  let timer = null
  let eventTimer = null
  let retryTimer = null
  let discoveryTimer = null
  let targetId = null
  let rootSpy = null
  let targetSpy = null
  let targetSpyId = null
  let targetRetryAt = 0
  let activeId = null
  let ids = []
  let rootReady = false
  let busy = false
  let dirty = false
  let forceGeometry = false
  let last = ''
  let geometry = null
  const children = new Set()
  const info = new Map()

  const run = (command, args) => new Promise(resolve => {
    if (stopped) { resolve(''); return }
    const child = execFile(command, args, { timeout: 1500 }, (error, stdout) => {
      children.delete(child)
      resolve(error ? '' : String(stdout))
    })
    children.add(child)
  })
  async function describe(id) {
    if (!info.has(id)) {
      const text = await run('xprop', ['-id', id, 'WM_CLASS', '_NET_WM_PID'])
      const app = parseXClass(text)
      const owner = Number((text.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/) || [])[1]) || 0
      // WM_CLASS can appear shortly after _NET_CLIENT_LIST. Do not cache an
      // empty class forever and miss an app that finishes opening later.
      const value = { ...app, pid: owner }
      if (app.id) info.set(id, value)
      return value
    }
    return info.get(id)
  }
  const isTarget = app => app.pid !== pid && matches(target, app.id, app.legacy)
  const publish = state => {
    if (stopped) return
    const text = JSON.stringify(state)
    if (text !== last) { last = text; onState(state) }
  }
  function schedule(force = false) {
    if (stopped) return
    forceGeometry ||= force
    if (busy) { dirty = true; return }
    if (!eventTimer) eventTimer = setTimeout(() => { eventTimer = null; tick() }, 12)
  }
  function watchTarget() {
    if (targetSpyId === targetId && targetSpy) return
    targetSpy?.kill()
    targetSpy = null
    targetSpyId = targetId
    if (!targetId || Date.now() < targetRetryAt) return
    const child = spawn('xprop', ['-spy', '-id', targetId, '_NET_WM_STATE'], { stdio: ['ignore', 'pipe', 'ignore'] })
    targetSpy = child
    child.stdout.on('data', () => schedule(true))
    const finished = () => {
      if (targetSpy !== child) return
      targetSpy = null
      targetRetryAt = Date.now() + 2000
    }
    child.on('error', finished)
    child.on('exit', finished)
  }
  async function tick() {
    if (stopped || busy || !rootReady) return
    busy = true
    const force = forceGeometry
    forceGeometry = false
    clearTimeout(timer)
    timer = null
    try {
      for (const id of [...info.keys()]) if (!ids.includes(id)) info.delete(id)
      let active = 'other'
      if (activeId && ids.includes(activeId)) {
        const app = await describe(activeId)
        if (app.pid === pid) active = 'ours'
        else if (isTarget(app)) {
          active = 'target'
          if (targetId !== activeId) { targetId = activeId; geometry = null }
        }
      }
      if (!targetId || !ids.includes(targetId)) {
        const previous = targetId
        targetId = null
        for (const id of ids) {
          if (isTarget(await describe(id))) { targetId = id; break }
        }
        if (previous !== targetId) geometry = null
      }
      if (stopped) return
      watchTarget()
      const visible = showWhen === 'open' || active === 'target' || active === 'ours'
      if (targetId && (force || !geometry || (visible && !geometry.minimized))) {
        const text = await run('xwininfo', ['-id', targetId, '-stats', '-wm'])
        const num = label => Number((text.match(new RegExp(`${label}:\\s+(-?\\d+)`)) || [])[1])
        const box = { x:num('Absolute upper-left X'), y:num('Absolute upper-left Y'), width:num('Width'), height:num('Height') }
        geometry = Object.values(box).every(Number.isFinite) ? {
          bounds: box, minimized: /Hidden/.test(text) || !/Map State: IsViewable/.test(text), fullscreen: /Fullscreen/.test(text),
        } : null
      }
      if (stopped) return
      const state = { found:!!(targetId && geometry), active, bounds:null, minimized:false, fullscreen:false, ...geometry }
      publish(state)
      // Hidden/minimized pets sleep until a focus, client, or state event.
      if (targetId && geometry && visible && !state.minimized) timer = setTimeout(tick, 200)
    } catch (error) {
      if (!stopped) onFail(error)
    } finally {
      busy = false
      if (dirty) { dirty = false; schedule() }
    }
  }
  function rootLine(line) {
    if (line.startsWith('_NET_ACTIVE_WINDOW')) {
      activeId = (line.match(/window id # (0x[0-9a-f]+)/i) || [])[1] || null
      schedule(activeId === targetId)
    } else if (line.startsWith('_NET_CLIENT_LIST(')) {
      ids = [...new Set(line.match(/0x[0-9a-f]+/gi) || [])].filter(id => id !== '0x0')
      rootReady = true
      schedule()
      clearTimeout(discoveryTimer)
      discoveryTimer = setTimeout(() => schedule(), 250)
    }
  }
  function startRootSpy() {
    if (stopped) return
    let buffer = ''
    const child = spawn('xprop', ['-spy', '-root', '_NET_ACTIVE_WINDOW', '_NET_CLIENT_LIST'], { stdio:['ignore','pipe','ignore'] })
    rootSpy = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,nl).trim()
        buffer = buffer.slice(nl+1)
        rootLine(line)
      }
    })
    let ended = false
    const finish = () => {
      if (ended || stopped) return
      ended = true
      rootSpy = null
      // Keep a recovery read for xprop versions/environments where -spy exits.
      retryTimer = setTimeout(async () => {
        if (stopped) return
        const root = await run('xprop', ['-root','_NET_ACTIVE_WINDOW','_NET_CLIENT_LIST'])
        if (root) root.split('\n').forEach(rootLine)
        else if (!stopped) onFail(new Error('xprop을 실행하지 못했어요.'))
        startRootSpy()
      }, 1000)
    }
    child.on('error', finish)
    child.on('exit', finish)
  }
  startRootSpy()
  return {
    stop() {
      stopped = true
      for (const timeout of [timer,eventTimer,retryTimer,discoveryTimer]) clearTimeout(timeout)
      rootSpy?.kill()
      targetSpy?.kill()
      for (const child of children) child.kill()
      children.clear()
    },
  }
}
module.exports = { start }
