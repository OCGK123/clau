// Enumerate normal desktop windows, never titles, command lines, or transient IDs.
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pick } = require('./tracker')
const { appsFromRows, parseXClass } = require('./tracker/identity')

const run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 6000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout))
})
function parseJSON(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, '').trim())
}
async function x11Rows() {
  const root = await run('xprop', ['-root', '_NET_CLIENT_LIST'])
  const ids = [...new Set(root.match(/0x[0-9a-f]+/gi) || [])].filter(id => id !== '0x0')
  const rows = []
  for (let start = 0; start < ids.length; start += 12) {
    rows.push(...await Promise.all(ids.slice(start, start + 12).map(async id => {
      // A window can disappear between the two reads. Ignore only that window.
      try {
        const text = await run('xprop', ['-id', id, 'WM_CLASS', '_NET_WM_PID', '_NET_WM_WINDOW_TYPE'])
        if (/_NET_WM_WINDOW_TYPE\(ATOM\)\s*=/.test(text) && !/_NET_WM_WINDOW_TYPE_NORMAL/.test(text)) return null
        const app = parseXClass(text)
        return { id: app.id, label: app.label, pid: Number((text.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/) || [])[1]) }
      } catch { return null }
    })))
  }
  return rows
}

let serial = 0
async function kwinRows(dir) {
  const dbus = require('dbus-next')
  const suffix = `${process.pid}_${++serial}`
  const service = `local.clau.AppList.p${suffix}`
  const plugin = `clau-app-list-${suffix}`
  const folder = await fs.mkdtemp(path.join(dir || os.tmpdir(), 'clau-apps-'))
  let bus
  try { bus = dbus.sessionBus() } catch (error) {
    await fs.rm(folder, { recursive: true, force: true })
    throw error
  }
  let stopped = false
  let timer
  let finish
  let failed
  let loadRequested = false
  const received = new Promise((resolve, reject) => { finish = resolve; failed = reject })
  // Register rejection handling immediately, while loading the KWin script.
  received.catch(() => {})
  const onError = error => failed(error)
  bus.on('error', onError)
  const call = (objectPath, iface, member, signature = '', body = []) => bus.call(new dbus.Message({
    destination: 'org.kde.KWin', path: objectPath, interface: iface, member, signature, body,
  }))
  class AppList extends dbus.interface.Interface {
    Update(text) { try { finish(parseJSON(text)) } catch (error) { failed(error) } }
  }
  AppList.configureMembers({ methods: { Update: { inSignature: 's', outSignature: '' } } })
  try {
    timer = setTimeout(() => failed(new Error('KWin 앱 목록 응답 시간이 초과됐어요.')), 6000)
    const setup = (async () => {
      await bus.requestName(service, 0)
      if (stopped) return
      bus.export('/Apps', new AppList('local.clau.AppList'))
      const source = `(function () {
        var all = workspace.windowList ? workspace.windowList() : workspace.clientList();
        var apps = [];
        for (var i = 0; i < all.length; i++) {
          var w = all[i];
          if (!w.normalWindow) continue;
          var id = String(w.resourceClass || w.resourceName || '');
          if (id) apps.push({id: id, label: id, pid: w.pid});
        }
        callDBus(${JSON.stringify(service)}, '/Apps', 'local.clau.AppList', 'Update', JSON.stringify(apps));
      })();`
      const file = path.join(folder, 'list.js')
      await fs.writeFile(file, source)
      if (stopped) return
      loadRequested = true
      const reply = await call('/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', [file, plugin])
      const id = reply.body[0]
      if (!(id >= 0)) throw new Error('KWin이 앱 목록 스크립트를 받아들이지 않았어요.')
      if (stopped) {
        await call('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {})
        return
      }
      await call(`/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run').catch(() => call(`/${id}`, 'org.kde.kwin.Script', 'run'))
    })()
    setup.catch(failed)
    // The deadline covers D-Bus setup as well as the actual script callback.
    await Promise.race([setup, received])
    return await received
  } finally {
    stopped = true
    clearTimeout(timer)
    // Queue unload even if the load reply never arrived. The KWin side may
    // already have loaded it; requests on this connection retain their order.
    if (loadRequested) {
      let cleanupDeadline
      try {
        await Promise.race([
          call('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {}),
          new Promise(resolve => { cleanupDeadline = setTimeout(resolve, 500) }),
        ])
      } finally { clearTimeout(cleanupDeadline) }
    }
    bus.removeListener('error', onError)
    bus.on('error', () => {})
    bus.disconnect()
    await fs.rm(folder, { recursive: true, force: true })
  }
}

async function list({ pid = process.pid, dir } = {}) {
  const kind = pick()
  if (!kind) return { kind: null, supported: false, apps: [], error: '이 데스크톱은 앱 목록을 제공하지 않아요. 화면 위 모드를 이용해 주세요.' }
  try {
    let rows
    if (kind === 'x11') rows = await x11Rows()
    else if (kind === 'kwin') rows = await kwinRows(dir)
    else if (kind === 'windows') rows = parseJSON(await run('powershell.exe', [
      '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tracker', 'windows.ps1'), '-OwnPid', String(pid), '-List',
    ]))
    else rows = parseJSON(await run('osascript', ['-l', 'JavaScript', path.join(__dirname, 'tracker', 'mac-helper.js'), String(pid), '--list']))
    return { kind, supported: true, apps: appsFromRows(rows, kind, pid) }
  } catch (error) {
    const missing = error.code === 'ENOENT'
    return { kind, supported: true, apps: [], error: missing ? '앱 목록 도우미를 찾지 못했어요. X11에서는 xprop이 필요해요.' : '앱 목록을 읽지 못했어요. 잠시 후 새로고침해 주세요.' }
  }
}
module.exports = { list, parseJSON }
