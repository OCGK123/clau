// macOS: normal windows and their bounds, without reading titles or requesting
// screen-recording permission. A cheap foreground check keeps hidden pets idle.
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
ObjC.import('AppKit')
ObjC.bindFunction('CFMakeCollectable', ['id', ['void *']])

function run(argv) {
  const ownPid = Number(argv[0]) || 0
  const listing = argv[1] === '--list'
  const showWhen = argv[2] === 'open' ? 'open' : 'focused'
  let target = { exact:false, id:'claude', compatible:true }
  if (!listing) { try { target = JSON.parse(argv[1]) } catch (_) {} }
  const identities = Object.create(null)
  function identity(w) {
    const key = String(w.kCGWindowOwnerPID)
    const cached = identities[key]
    const name = String(w.kCGWindowOwnerName || '')
    if (cached && cached.name === name && Date.now() - cached.at < 30000) return cached.id
    let id = 'name:' + name.toLowerCase()
    try {
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID)
      const bundle = ObjC.unwrap(app.bundleIdentifier)
      if (bundle) id = String(bundle).toLowerCase()
    } catch (_) {}
    identities[key] = { id, name, at:Date.now() }
    return id
  }
  function foreground() {
    try {
      const app = $.NSWorkspace.sharedWorkspace.frontmostApplication
      const pid = Number(app.processIdentifier)
      const name = String(ObjC.unwrap(app.localizedName) || '')
      const bundle = ObjC.unwrap(app.bundleIdentifier)
      const id = bundle ? String(bundle).toLowerCase() : 'name:' + name.toLowerCase()
      return { pid, active:pid === ownPid ? 'ours' : target.compatible && (target.exact ? id === target.id : name.toLowerCase().includes(target.id)) ? 'target' : 'other' }
    } catch (_) { return null }
  }
  const out = $.NSFileHandle.fileHandleWithStandardOutput
  const say = text => out.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const options = (listing ? $.kCGWindowListOptionAll : $.kCGWindowListOptionOnScreenOnly) | $.kCGWindowListExcludeDesktopElements
  // 따라붙을 창이 2초 넘게 그대로면 0.35초마다, 움직이기 시작하면 다시 0.15초마다 살핀다.
  // 창 목록 전체를 0.15초마다 읽는 일은 가볍지 않아서, 가만히 있을 때까지 그렇게 할 필요는 없다.
  let quietSince = Date.now()
  const pause = () => {
    const seconds = Date.now() - quietSince > 2000 ? 0.35 : 0.15
    const until = Date.now() + seconds * 1000
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds))
    // An empty run loop may return early; never turn that into a busy loop.
    const remaining = until - Date.now()
    if (remaining > 0) delay(remaining / 1000)
  }
  let last = ''
  let cachedMessage = null
  let lastScan = 0
  let lastFront = null
  // Recycle periodically to bound the helper's Objective-C bridge allocations.
  for (let i = 0; i < 4000; i++) {
    const frontApp = listing ? null : foreground()
    const visible = !frontApp || showWhen === 'open' || frontApp.active === 'target' || frontApp.active === 'ours'
    const scan = listing || visible || !cachedMessage || Date.now() - lastScan >= 2000
    let msg
    if (scan) {
      const list = ObjC.deepUnwrap($.CFMakeCollectable($.CGWindowListCopyWindowInfo(options, 0))) || []
      const normal = list.filter(w => w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 80)
      if (listing) {
        say(JSON.stringify(normal.filter(w => w.kCGWindowOwnerPID !== ownPid).map(w => ({id:identity(w),label:w.kCGWindowOwnerName,pid:w.kCGWindowOwnerPID}))))
        return
      }
      const isTarget = w => target.compatible && w.kCGWindowOwnerPID !== ownPid && (target.exact ? identity(w) === target.id : String(w.kCGWindowOwnerName || '').toLowerCase().includes(target.id))
      const front = normal[0]
      const win = normal.find(isTarget)
      msg = { found:!!win, active:!front ? 'other' : front.kCGWindowOwnerPID === ownPid ? 'ours' : isTarget(front) ? 'target' : 'other' }
      if (win) {
        const b = win.kCGWindowBounds
        msg.rect = [Math.round(b.X),Math.round(b.Y),Math.round(b.Width),Math.round(b.Height)]
        msg.minimized = false
      }
      cachedMessage = msg
      lastScan = Date.now()
    } else if (frontApp.pid !== lastFront || cachedMessage.active !== frontApp.active) {
      msg = { ...cachedMessage, active:frontApp.active }
      cachedMessage = msg
    }
    lastFront = frontApp?.pid ?? null
    if (msg) {
      const text = JSON.stringify(msg)
      if (text !== last) { last = text; say(text); quietSince = Date.now() }
    }
    // Service AppKit's run loop so frontmostApplication stays current.
    pause()
  }
}
