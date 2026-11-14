// 배터리 측정: 클로를 띄워 상태별로 CPU 시간과 문맥 전환 수를 잰다.
//   기본: 가상 화면(Xvfb). 그림이 소프트웨어로 그려지므로 GPU가 할 일도 CPU 시간에 잡힌다.
//   --real: 지금 화면에 잠깐 띄운다. 화면을 합성하는 창 관리자(kwin_wayland, Xwayland)의 CPU와
//           GPU 사용률(AMD, /sys/class/drm/*/device/gpu_busy_percent)도 같이 잰다.
//
//   node scripts/bench.mjs [--app <클로 폴더>] [--seconds 20] [--out result.json] [--only idle,hidden] [--real]
//
// Linux 전용(/proc, xvfb-run). 사용자의 설정·Claude Code 폴더는 건드리지 않는다(HOME과 프로필을 임시로 둔다).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const appDir = path.resolve(arg('app', root))
const seconds = Number(arg('seconds', 20))
const settle = Number(arg('settle', 3))
const out = arg('out', '')
const only = arg('only', '')
const real = process.argv.includes('--real')
const PORT = 9300 + Math.floor(Math.random() * 500)
const HZ = 100 // /proc 의 시간 단위(clock ticks)

const SCENARIOS = [
  // 이름, 설명, 시작할 때 main 에서 돌릴 코드
  ['idle', '가만히(보임)', `pet("recompute()")`],
  ['look', '마우스 움직임(눈 따라보기)', `look()`],
  ['thinking', 'Claude Code 생각 중', `pet("cc={mode:'thinking',at:Date.now()};recompute()")`],
  ['talking', 'Claude Code 말하는 중', `pet("cc={mode:'talking',at:Date.now()};recompute()")`],
  ['sleeping', '사용 한도(잠)', `pet("limitUntil=Date.now()+3600e3;recompute()")`],
  ['hidden', '숨김(Claude 창이 뒤에 있음)', `hide()`],
  ['battery', '배터리로 가만히', `battery()`],
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

function tree(rootPid) {
  const all = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))
  const parent = new Map()
  for (const pid of all) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      parent.set(Number(pid), Number(after[1]))
    } catch {}
  }
  const keep = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, ppid] of parent) if (!keep.has(pid) && keep.has(ppid)) { keep.add(pid); grew = true }
  }
  return [...keep]
}

function kind(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/)
    const type = cmd.find(a => a.startsWith('--type='))?.slice(7)
    const sub = cmd.find(a => a.startsWith('--utility-sub-type='))?.slice(19).split('.')[0]
    if (!type) return cmd[0].includes('electron') ? 'main' : path.basename(cmd[0])
    return sub ? `${type}:${sub}` : type
  } catch { return '?' }
}

function sample(pids) {
  const rows = {}
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ticks = Number(f[11]) + Number(f[12]) // utime + stime (자식 제외)
      let wakes = 0
      for (const t of fs.readdirSync(`/proc/${pid}/task`)) {
        try {
          const s = fs.readFileSync(`/proc/${pid}/task/${t}/status`, 'utf8')
          wakes += Number(s.match(/voluntary_ctxt_switches:\s+(\d+)/)[1]) + Number(s.match(/nonvoluntary_ctxt_switches:\s+(\d+)/)[1])
        } catch {}
      }
      rows[pid] = { kind: kind(pid), ticks, wakes }
    } catch {}
  }
  return rows
}

function diff(a, b, secs) {
  const by = {}
  let cpu = 0
  let wakes = 0
  for (const [pid, row] of Object.entries(b)) {
    const before = a[pid]
    if (!before) continue
    const c = ((row.ticks - before.ticks) / HZ / secs) * 100
    const w = (row.wakes - before.wakes) / secs
    cpu += c
    wakes += w
    const k = row.kind
    by[k] = by[k] || { cpu: 0, wakes: 0 }
    by[k].cpu += c
    by[k].wakes += w
  }
  for (const k of Object.keys(by)) by[k] = { cpu: +by[k].cpu.toFixed(2), wakes: Math.round(by[k].wakes) }
  return { cpu: +cpu.toFixed(2), wakes: Math.round(wakes), by }
}

/** 화면 합성 쪽 프로세스(창 관리자, XWayland): --real 일 때 같이 잰다. */
function compositorPids() {
  const out = []
  for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try {
      const name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
      if (['kwin_wayland', 'Xwayland', 'kwin_x11', 'gnome-shell', 'Xorg'].includes(name)) out.push(Number(pid))
    } catch {}
  }
  return out
}
const gpuFiles = () => {
  try { return fs.readdirSync('/sys/class/drm').map(d => `/sys/class/drm/${d}/device/gpu_busy_percent`).filter(f => fs.existsSync(f)).filter((f, i, a) => a.indexOf(f) === i) } catch { return [] }
}
/** seconds 동안 0.1초마다 GPU 사용률을 읽어 평균을 낸다. */
async function gpuBusy(seconds) {
  const files = gpuFiles()
  if (!files.length) return null
  let sum = 0
  let n = 0
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    for (const f of files) { try { sum += Number(fs.readFileSync(f, 'utf8')); n++ } catch {} }
    await sleep(100)
  }
  return n ? +(sum / n).toFixed(1) : null
}

async function inspector() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (list[0]?.webSocketDebuggerUrl) return list[0].webSocketDebuggerUrl
    } catch {}
    await sleep(200)
  }
  throw new Error('inspector not reachable')
}

function connect(url) {
  const ws = new WebSocket(url)
  let id = 0
  const waiting = new Map()
  ws.onmessage = m => {
    const msg = JSON.parse(m.data)
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
  }
  const ready = new Promise(r => (ws.onopen = r))
  const evaluate = async expression => {
    await ready
    const n = ++id
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const res = await new Promise(r => waiting.set(n, r))
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400))
    return res.result?.result?.value
  }
  return { evaluate, close: () => ws.close() }
}

// main 프로세스 안에 심는 도우미: 펫 창 찾기, 상태 바꾸기, 마우스 흉내, 숨기기, 배터리 흉내.
const HELPERS = `(() => {
  const { BrowserWindow, powerMonitor } = process.mainModule.require('electron')
  const win = () => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Clau')
  let lookTimer = null
  globalThis.__bench = {
    win,
    pet: code => win().webContents.executeJavaScript(code),
    reset: async () => {
      clearInterval(lookTimer); lookTimer = null
      const w = win()
      if (!w.isVisible()) { w.showInactive(); w.webContents.send('pet:visibility', true) }
      w.webContents.send('pet:power', { battery: false })
      await w.webContents.executeJavaScript("cc=null;limitUntil=0;setLocal(null);dozing=false;idleSince=Date.now();recompute()")
    },
    look: () => {
      let t = 0
      lookTimer = setInterval(() => { t += 0.033; win().webContents.send('pet:look', { x: Math.round(400 + 300 * Math.cos(t)), y: Math.round(200 + 150 * Math.sin(t * 1.3)) }) }, 33)
    },
    hide: () => { const w = win(); w.webContents.send('pet:visibility', false); w.hide() },
    battery: () => win().webContents.send('pet:power', { battery: true }),
  }
  return true
})()`

async function runApp(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clau-bench-'))
  const profile = path.join(home, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    placement: 'free', position: real ? { x: 160, y: 820 } : { x: 600, y: 300 }, followClaudeCode: true, updateCheck: false,
    soundEnabled: false, wakeWithClaude: false, tray: false, dozeMinutes: 0,
  }))
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
  const appArgs = [appDir, `--user-data-dir=${profile}`, `--inspect=${PORT}`, '--no-sandbox', '--ozone-platform=x11']
  const child = real
    ? spawn(electron, appArgs, { cwd: appDir, env: { ...process.env, HOME: home, CLAU_NATIVE: '1' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
    : spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, ...appArgs], {
    cwd: appDir,
    env: { ...process.env, HOME: home, CLAU_NATIVE: '1', XDG_CURRENT_DESKTOP: 'bench', KDE_FULL_SESSION: '', XDG_SESSION_TYPE: 'x11' },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  try {
    const ws = connect(await inspector())
    await ws.evaluate(HELPERS)
    for (let i = 0; i < 50 && !(await ws.evaluate('!!(__bench.win() && __bench.win().isVisible())')); i++) await sleep(200)
    await sleep(2500)
    const electronPid = () => tree(child.pid).find(pid => kind(pid) === 'main')
    const results = {}
    for (const [name, note, code] of SCENARIOS) {
      if (only && !only.split(',').includes(name)) continue
      await ws.evaluate('__bench.reset()')
      await ws.evaluate(code.replace(/^(\w+)\(/, '__bench.$1('))
      await sleep(settle * 1000)
      const pids = tree(electronPid())
      const comp = real ? compositorPids() : []
      const a = sample(pids)
      const ca = sample(comp)
      const gpu = real ? await gpuBusy(seconds) : (await sleep(seconds * 1000), null)
      const b = sample(pids)
      const cb = sample(comp)
      results[name] = { note, ...diff(a, b, seconds) }
      if (real) {
        const c = diff(ca, cb, seconds)
        results[name].compositor = { cpu: c.cpu, wakes: c.wakes }
        results[name].gpuBusy = gpu
      }
      const extra = real ? `  compositor CPU ${results[name].compositor.cpu}%  GPU ${gpu}%` : ''
      console.log(`${label.padEnd(8)} ${name.padEnd(9)} CPU ${String(results[name].cpu).padStart(6)}%  context-switches/s ${String(results[name].wakes).padStart(5)}${extra}  ${JSON.stringify(results[name].by)}`)
    }
    // 정상 종료: 창 관리자에 올린 스크립트를 내리고 끝난다.
    await ws.evaluate("process.mainModule.require('electron').app.quit()").catch(() => {})
    for (let i = 0; i < 30; i++) { try { process.kill(child.pid, 0) } catch { break } await sleep(100) }
    ws.close()
    return results
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    await sleep(500)
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    fs.rmSync(home, { recursive: true, force: true })
    if (process.env.BENCH_DEBUG) console.error(stderr.slice(-2000))
  }
}

const label = arg('label', path.basename(appDir))
const results = await runApp(label)
if (out) fs.writeFileSync(out, JSON.stringify({ label, app: appDir, seconds, results }, null, 2))
