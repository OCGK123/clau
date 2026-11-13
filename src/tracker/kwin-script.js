// KWin 안에서 도는 스크립트. 따라붙을 앱(Claude) 창의 자리와 포커스,
// 그리고 펫 창 위에 마우스가 있는지를 D-Bus로 펫 앱에 알려 준다.
// 밑줄 두 개로 감싼 이름들은 앱이 실제 값으로 바꿔 넣는다.
(function () {
  var SERVICE = '__SERVICE__'
  var OWN_PID = __PID__
  var TARGET = __TARGET_SPEC__
  var IN_TASKBAR = __TASKBAR__
  var LOOK = __LOOK__ // 눈이 마우스를 따라볼 때만 마우스 자리를 알린다
  var lastLook = 0

  var target = null
  var pet = null
  var hover = false
  var inWindow = false
  var hit = null // 펫 창 안에서 캐릭터가 차지하는 자리 [x, y, w, h]. 창이 캐릭터보다 훨씬 크다.
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
  // 클로의 다른 창(말풍선). 설정 창은 보통 창이라 건드리지 않는다.
  function isHelper(w) {
    return ours(w) && !isPet(w) && String(w.caption) !== '클로 설정'
  }
  function quiet(w) {
    // 창 전환기·페이저·작업 표시줄에서 빼고, 창 관리자가 그리는 테두리나 주목 표시가 붙지 않게 한다.
    try {
      w.skipSwitcher = true
      w.skipPager = true
      w.noBorder = true
      if (w.demandsAttention) w.demandsAttention = false
    } catch (e) {}
  }
  function rect(w) {
    var g = w.frameGeometry
    return [Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height)]
  }
  function inside(p, w) {
    var g = w.frameGeometry
    return p.x >= g.x && p.x < g.x + g.width && p.y >= g.y && p.y < g.y + g.height
  }
  // 마우스가 캐릭터 위에 있을 때만 클릭을 받는다. 창 전체로 보면 그 큰 투명 영역이 화면 클릭을 막는다.
  function overPet(p) {
    if (!pet || !hit || !inside(p, pet)) return false
    var g = pet.frameGeometry
    return p.x >= g.x + hit[0] && p.x < g.x + hit[0] + hit[2] && p.y >= g.y + hit[1] && p.y < g.y + hit[1] + hit[3]
  }
  function updateHover() {
    var now = overPet(workspace.cursorPos)
    if (now === hover) return
    hover = now
    report()
  }
  // 앱에 캐릭터 자리를 묻는다. 창이 움직이거나 마우스가 창에 들어올 때만.
  function refreshHit() {
    callDBus(SERVICE, '/Tracker', 'local.clau.Tracker', 'HitRect', function (text) {
      try {
        var r = JSON.parse(text)
        hit = r && r.length === 4 ? r : null
      } catch (e) {
        hit = null
      }
      updateHover()
    })
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
  var helpers = []
  function adopt(w) {
    if (isPet(w)) {
      if (pet === w) return // Activating Clau must not add duplicate geometry listeners.
      pet = w
      // Claude 창의 일부처럼 보이도록 창 전환기(Alt+Tab)와 페이저에서 뺀다. 작업 표시줄은 설정을 따른다.
      quiet(w)
      try {
        w.skipTaskbar = !IN_TASKBAR
      } catch (e) {}
      w.frameGeometryChanged.connect(function () {
        refreshHit()
        report()
      })
      refreshHit()
    } else if (isHelper(w)) {
      quiet(w)
      try {
        w.skipTaskbar = true
      } catch (e) {}
      if (helpers.indexOf(w) === -1) {
        helpers.push(w)
        if (w.demandsAttentionChanged) w.demandsAttentionChanged.connect(function () { quiet(w) })
      }
      // 사용자가 클로를 눌러 말풍선을 연 순간이면 바로 입력할 수 있게 앞으로 가져온다.
      // (KDE의 포커스 가로채기 방지는 앱이 스스로 창을 앞으로 가져오는 것을 막는다.)
      callDBus(SERVICE, '/Tracker', 'local.clau.Tracker', 'WantsFocus', function (yes) {
        if (yes && w !== active()) workspace.activeWindow = w
      })
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
    var h = helpers.indexOf(w)
    if (h !== -1) helpers.splice(h, 1)
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
      var entered = !!pet && inside(workspace.cursorPos, pet)
      if (entered && !inWindow) refreshHit()
      inWindow = entered
      updateHover()
      // 다른 앱 위에 있는 마우스 자리는 창 관리자만 안다. 1초에 30번까지만 알린다.
      if (LOOK && pet) {
        var now = Date.now()
        if (now - lastLook >= 33) {
          lastLook = now
          var p = workspace.cursorPos
          callDBus(SERVICE, '/Tracker', 'local.clau.Tracker', 'Cursor', Math.round(p.x) + ',' + Math.round(p.y))
        }
      }
    })
  }
  report()
})()
