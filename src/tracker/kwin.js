// KDE(KWin): 작은 KWin 스크립트를 올려 두고, 그 스크립트가 D-Bus로 보내는 소식을 받는다.
// Wayland에서는 다른 앱의 창 위치를 물어볼 방법이 창 관리자뿐이라 이렇게 한다.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let serial = 0

function start({ target, taskbar, look, pid, dir, onState, onFail, hitRect, wantsFocus, onCursor }) {
  let dbus
  try {
    dbus = require('dbus-next')
  } catch (err) {
    onFail(err)
    return { stop() {} }
  }
  // A settings change can replace a tracker before its async stop finishes.
  // Unique names prevent the retiring tracker from unloading the replacement.
  const suffix = `${process.pid}_${++serial}`
  const service = `local.clau.Tracker.p${suffix}`
  const plugin = `clau-tracker-${suffix}`
  const bus = dbus.sessionBus()
  let scriptFile = null
  let scriptDir = null
  let stopped = false
  let cleanup = null
  const fail = error => { if (!stopped) { onFail(error); stop() } }
  bus.on('error', fail)

  const call = (objectPath, iface, member, signature = '', body = []) =>
    bus.call(new dbus.Message({ destination: 'org.kde.KWin', path: objectPath, interface: iface, member, signature, body }))

  class Tracker extends dbus.interface.Interface {
    Update(text) {
      if (stopped) return
      try {
        const m = JSON.parse(text)
        const box = r => (r ? { x: r[0], y: r[1], width: r[2], height: r[3] } : null)
        onState({
          found: !!m.found,
          active: m.active,
          bounds: box(m.rect),
          minimized: !!m.minimized,
          fullscreen: !!m.fullscreen,
          hover: !!m.hover,
          own: box(m.pet), // 창 관리자가 본 펫 창: 좌표 단위를 맞추는 데 쓴다
        })
      } catch {
        // 깨진 메시지는 버린다.
      }
    }
    /** 펫 창 안에서 캐릭터가 차지하는 자리(창 관리자 단위, JSON). 스크립트가 마우스 판정에 쓴다. */
    HitRect() {
      try { return String(hitRect?.() || '') } catch { return '' }
    }
    /** 방금 사용자가 말풍선을 열었는가: 그렇다면 스크립트가 말풍선 창을 앞으로 가져온다. */
    Cursor(text) {
      const [x, y] = String(text).split(',').map(Number)
      if (Number.isFinite(x) && Number.isFinite(y)) onCursor?.(x, y)
    }
    WantsFocus() {
      try { return !!wantsFocus?.() } catch { return false }
    }
  }
  Tracker.configureMembers({ methods: { Update: { inSignature: 's', outSignature: '' }, HitRect: { inSignature: '', outSignature: 's' }, WantsFocus: { inSignature: '', outSignature: 'b' }, Cursor: { inSignature: 's', outSignature: '' } } })

  ;(async () => {
    await bus.requestName(service, 0)
    if (stopped) return
    bus.export('/Tracker', new Tracker('local.clau.Tracker'))

    const source = fs
      .readFileSync(path.join(__dirname, 'kwin-script.js'), 'utf8')
      .replaceAll('__SERVICE__', service)
      .replaceAll('__PID__', String(pid))
      .replaceAll('__TASKBAR__', taskbar ? 'true' : 'false')
      .replaceAll('__LOOK__', look ? 'true' : 'false')
      .replaceAll('__TARGET_SPEC__', () => JSON.stringify(target))
    scriptDir = fs.mkdtempSync(path.join(dir || os.tmpdir(), 'clau-tracker-'))
    scriptFile = path.join(scriptDir, 'tracker.js')
    fs.writeFileSync(scriptFile, source)

    const reply = await call('/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', [scriptFile, plugin])
    const id = reply.body[0]
    if (!(id >= 0)) throw new Error('KWin이 스크립트를 받아들이지 않았어요.')
    if (stopped) return
    await call(`/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run').catch(() =>
      call(`/${id}`, 'org.kde.kwin.Script', 'run'),
    )
  })().catch(fail)

  function stop() {
    if (cleanup) return cleanup
    stopped = true
    const unload = scriptFile
      ? call('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {})
      : Promise.resolve()
    let deadline
    cleanup = Promise.race([unload, new Promise(resolve => { deadline = setTimeout(resolve, 500) })]).finally(() => {
      clearTimeout(deadline)
      try { if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true }) } catch {}
      bus.removeListener('error', fail)
      bus.on('error', () => {})
      bus.disconnect()
    })
    return cleanup
  }
  return { stop }
}

module.exports = { start }
