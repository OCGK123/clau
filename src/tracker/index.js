// 따라붙을 앱(기본: Claude) 창이 어디에 있고 지금 앞에 나와 있는지를 알려 준다.
// OS마다 방법이 달라서 여기서 하나를 고르고, 결과를 같은 모양으로 맞춘다.
//
// onState({ found, focused, active, bounds, minimized, fullscreen, hover, own })
//   bounds  창의 자리. units가 말하는 단위 그대로다.
//   hover   펫 창 위에 마우스가 있는지. 알 수 없는 방식에서는 undefined.
//   own     창 관리자가 본 펫 창(KWin만). 단위를 맞추는 데 쓴다.
const path = require('node:path')
const { follow } = require('./lines')
const { targetSpec } = require('./identity')

function pick() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'linux') {
    const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase()
    if (desktop.includes('kde') || process.env.KDE_FULL_SESSION === 'true') return 'kwin'
    // 다른 Wayland 데스크톱(GNOME 등)은 남의 창 위치를 알려 주지 않는다.
    if (process.env.XDG_SESSION_TYPE !== 'wayland' && process.env.DISPLAY) return 'x11'
  }
  return null
}

const box = r => (Array.isArray(r) ? { x: r[0], y: r[1], width: r[2], height: r[3] } : null)

/** 도우미 프로세스가 보낸 { found, active, rect, minimized } 를 공통 모양으로. */
const fromHelper = m => ({
  found: !!m.found,
  active: m.active,
  bounds: box(m.rect),
  minimized: !!m.minimized,
  fullscreen: false,
})

function create({ target, taskbar, pid, dir, showWhen = 'focused', onState, onFail }) {
  const kind = pick()
  const spec = targetSpec(target, kind)
  const emit = state => onState({ ...state, focused: state.active === 'target' || state.active === 'ours' })
  let failed = false
  const fail = err => {
    if (failed) return
    failed = true
    onFail(err)
  }

  let backend = null
  // 단위: 'dip'은 Electron과 같은 단위, 'px'는 실제 화면 픽셀, 'wm'은 창 관리자 단위(own으로 맞춘다).
  let units = 'dip'
  if (kind === 'kwin') {
    units = 'wm'
    backend = require('./kwin').start({ target: spec, taskbar, pid, dir, onState: emit, onFail: fail })
  } else if (kind === 'x11') {
    units = 'px'
    backend = require('./x11').start({ target: spec, pid, showWhen, onState: emit, onFail: fail })
  } else if (kind === 'windows') {
    units = 'px'
    backend = follow({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows.ps1'), '-OwnPid', String(pid), '-Target', spec.id, '-Exact', String(spec.exact), '-Compatible', String(spec.compatible), '-ShowWhen', showWhen],
      onMessage: m => emit(fromHelper(m)),
      onFail: fail,
    })
  } else if (kind === 'mac') {
    backend = follow({
      command: 'osascript',
      args: ['-l', 'JavaScript', path.join(__dirname, 'mac-helper.js'), String(pid), JSON.stringify(spec), showWhen],
      onMessage: m => emit(fromHelper(m)),
      onFail: fail,
    })
  }

  return {
    kind,
    units,
    supported: !!backend,
    stop: () => backend?.stop(),
  }
}

module.exports = { create, pick }
