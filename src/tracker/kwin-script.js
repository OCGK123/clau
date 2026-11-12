// KWin 안에서 도는 스크립트. 따라붙을 앱(Claude) 창의 자리와 포커스,
// 그리고 펫 창 위에 마우스가 있는지를 D-Bus로 펫 앱에 알려 준다.
// 밑줄 두 개로 감싼 이름들은 앱이 실제 값으로 바꿔 넣는다.
(function () {
  var SERVICE = '__SERVICE__'
  var OWN_PID = __PID__
  var TARGET = __TARGET_SPEC__
  var IN_TASKBAR = __TASKBAR__

  var target = null
  var pet = null
  var hover = false
  var last = ''

  function windows() {
    return workspace.windowList ? workspace.windowList() : workspace.clientList()
  }
  function active() {
    return workspace.activeWindow !== undefined ? workspace.activeWindow : workspace.activeClient
  }
  function ours(w) {
    return !!w && w.pid === OWN_PID
  }
  function isTarget(w) {
    if (!w || ours(w) || !w.normalWindow) return false
    var name = (String(w.resourceClass) + ' ' + String(w.resourceName)).toLowerCase()
    if (!TARGET.compatible) return false
    return TARGET.exact ? String(w.resourceClass || w.resourceName || '').toLowerCase() === TARGET.id : name.indexOf(TARGET.id) !== -1
  }
  function isPet(w) {
    return ours(w) && String(w.caption) === 'Clau'
  }
  function rect(w) {
    var g = w.frameGeometry
    return [Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height)]
  }
  function inside(p, w) {
    var g = w.frameGeometry
    return p.x >= g.x && p.x < g.x + g.width && p.y >= g.y && p.y < g.y + g.height
  }
  function onThisDesktop(w) {
    if (w.onAllDesktops || !w.desktops || !w.desktops.length) return true
    for (var i = 0; i < w.desktops.length; i++) if (w.desktops[i] === workspace.currentDesktop) return true
    return false
  }

  function report() {
    var a = active()
    var msg = {
      found: !!target,
      active: isTarget(a) ? 'target' : ours(a) ? 'ours' : 'other',
      hover: hover,
    }
    if (target) {
      msg.rect = rect(target)
      msg.minimized = !!target.minimized || !onThisDesktop(target)
      msg.fullscreen = !!target.fullScreen
    }
    if (pet) msg.pet = rect(pet)
    var text = JSON.stringify(msg)
    if (text === last) return
    last = text
    callDBus(SERVICE, '/Tracker', 'local.clau.Tracker', 'Update', text)
  }

  function watchTarget(w) {
    w.frameGeometryChanged.connect(report)
    w.minimizedChanged.connect(report)
    if (w.fullScreenChanged) w.fullScreenChanged.connect(report)
    if (w.desktopsChanged) w.desktopsChanged.connect(report)
  }

  var watched = []
  function adopt(w) {
    if (isPet(w)) {
      if (pet === w) return // Activating Clau must not add duplicate geometry listeners.
      pet = w
      // Claude 창의 일부처럼 보이도록 창 전환기(Alt+Tab)와 페이저에서 뺀다. 작업 표시줄은 설정을 따른다.
      try {
        w.skipSwitcher = true
        w.skipPager = true
        w.skipTaskbar = !IN_TASKBAR
      } catch (e) {}
      w.frameGeometryChanged.connect(report)
    } else if (isTarget(w)) {
      if (watched.indexOf(w) === -1) {
        watched.push(w)
        watchTarget(w)
      }
      if (!target || w === active()) target = w
    }
  }
  function forget(w) {
    var i = watched.indexOf(w)
    if (i !== -1) watched.splice(i, 1)
    if (w === pet) pet = null
    if (w === target) target = watched.length ? watched[watched.length - 1] : null
    report()
  }

  var all = windows()
  for (var i = 0; i < all.length; i++) adopt(all[i])

  var added = workspace.windowAdded || workspace.clientAdded
  var removed = workspace.windowRemoved || workspace.clientRemoved
  var activated = workspace.windowActivated || workspace.clientActivated
  added.connect(function (w) {
    adopt(w)
    report()
  })
  removed.connect(forget)
  activated.connect(function (w) {
    // 창이 뜬 직후에는 제목이 비어 있을 수 있어서, 활성화될 때 한 번 더 살핀다.
    if (w) adopt(w)
    if (isTarget(w)) target = w
    report()
  })
  if (workspace.currentDesktopChanged) workspace.currentDesktopChanged.connect(report)
  if (workspace.cursorPosChanged) {
    workspace.cursorPosChanged.connect(function () {
      var now = !!pet && inside(workspace.cursorPos, pet)
      if (now === hover) return
      hover = now
      report()
    })
  }
  report()
})()
