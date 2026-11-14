// 상태별로 화면을 실제로 몇 번 다시 그렸는지(초당 합성 프레임) 센다. CPU 시간보다 덜 흔들리는 지표다.
// Chromium 추적(contentTracing)의 'Display::DrawAndSwap'(그려서 내보낸 프레임)과 렌더러의 requestAnimationFrame 호출 수를 센다.
//
//   node scripts/frames.mjs [--app <클로 폴더>] [--seconds 4]
//
// Linux 전용(xvfb-run). 사용자의 설정·Claude Code 폴더는 건드리지 않는다.
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
const seconds = Number(arg('seconds', 4))
const out = arg('out', '')
const PORT = 9800 + Math.floor(Math.random() * 150)
const sleep = ms => new Promise(r => setTimeout(r, ms))
/**
 * 추적 파일에서 그려서 내보낸 프레임(Display::DrawAndSwap) 수. 파일은 JSON이거나 Perfetto(protobuf)다.
 * protobuf는 필요한 칸만 읽는다: TracePacket(1) → track_event(11)의 name_iid(10)/name(23)/type(9),
 * interned_data(12)의 event_names(2: iid 1, name 2), 순서 번호 trusted_packet_sequence_id(10).
 */
function countDraws(raw) {
  const NAME = 'Display::DrawAndSwap'
  if (raw[0] === 0x7b || raw[0] === 0x5b) {
    const trace = JSON.parse(raw.toString('utf8'))
    const events = Array.isArray(trace) ? trace : trace.traceEvents
    return events.filter(e => e.name === NAME && (e.ph === 'X' || e.ph === 'B')).length
  }
  const fields = function* (buf, start, end) {
    let i = start
    while (i < end) {
      let key = 0, shift = 0, b
      do { b = buf[i++]; key += (b & 0x7f) * 2 ** shift; shift += 7 } while (b & 0x80)
      const field = Math.floor(key / 8), wire = key & 7
      if (wire === 0) { let v = 0; shift = 0; do { b = buf[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7 } while (b & 0x80); yield [field, wire, v] }
      else if (wire === 2) { let n = 0; shift = 0; do { b = buf[i++]; n += (b & 0x7f) * 2 ** shift; shift += 7 } while (b & 0x80); yield [field, wire, [i, i + n]]; i += n }
      else if (wire === 1) { i += 8 } else if (wire === 5) { i += 4 } else return
    }
  }
  const names = new Map() // `${seq}:${iid}` → 이름
  const pending = []
  for (const [field, wire, at] of fields(raw, 0, raw.length)) {
    if (field !== 1 || wire !== 2) continue
    let seq = 0, track = null, interned = null
    for (const [f, w, v] of fields(raw, at[0], at[1])) {
      if (f === 10 && w === 0) seq = v
      else if (f === 11 && w === 2) track = v
      else if (f === 12 && w === 2) interned = v
    }
    if (interned) for (const [f, w, v] of fields(raw, interned[0], interned[1])) {
      if (f !== 2 || w !== 2) continue
      let iid = 0, name = ''
      for (const [ff, ww, vv] of fields(raw, v[0], v[1])) { if (ff === 1 && ww === 0) iid = vv; else if (ff === 2 && ww === 2) name = raw.subarray(vv[0], vv[1]).toString('utf8') }
      names.set(`${seq}:${iid}`, name)
    }
    if (track) {
      let type = 0, iid = null, name = null
      for (const [f, w, v] of fields(raw, track[0], track[1])) {
        if (f === 9 && w === 0) type = v
        else if (f === 10 && w === 0) iid = v
        else if (f === 23 && w === 2) name = raw.subarray(v[0], v[1]).toString('utf8')
      }
      if (type === 1 || type === 3) pending.push(name ?? `${seq}:${iid}`)
    }
  }
  return pending.filter(key => key === NAME || names.get(key) === NAME).length
}

const SCENES = [
  ['idle', '가만히', "cc=null;limitUntil=0;setLocal(null);recompute()"],
  ['thinking', 'Claude Code 생각 중', "cc={mode:'thinking',at:Date.now()};recompute()"],
  ['talking', 'Claude Code 말하는 중', "cc={mode:'talking',at:Date.now()};recompute()"],
  ['sleeping', '사용 한도(잠)', "cc=null;limitUntil=Date.now()+3600e3;recompute()"],
  ['battery', '배터리로 가만히', "limitUntil=0;recompute()"],
]

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clau-frames-'))
fs.mkdirSync(path.join(home, 'profile'))
fs.writeFileSync(path.join(home, 'profile', 'settings.json'), JSON.stringify({ placement: 'free', position: { x: 600, y: 300 }, followClaudeCode: true, updateCheck: false, soundEnabled: false, tray: false, dozeMinutes: 0, wakeWithClaude: false }))
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, appDir, `--user-data-dir=${path.join(home, 'profile')}`, `--inspect=${PORT}`, '--no-sandbox', '--ozone-platform=x11'], {
  env: { ...process.env, HOME: home, CLAU_NATIVE: '1', XDG_CURRENT_DESKTOP: 'bench', XDG_SESSION_TYPE: 'x11', KDE_FULL_SESSION: '' },
  stdio: 'ignore',
  detached: true,
})
try {
  let url
  for (let i = 0; i < 100 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())[0]?.webSocketDebuggerUrl } catch {} if (!url) await sleep(200) }
  const ws = new WebSocket(url)
  await new Promise(r => (ws.onopen = r))
  let id = 0
  const waiting = new Map()
  ws.onmessage = m => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id) } }
  const ev = async e => { const n = ++id; ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); const r = await new Promise(r => waiting.set(n, r)); return r.result?.result?.value }
  await sleep(4000)
  const W = `const {BrowserWindow,contentTracing}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Clau')`
  const pet = code => ev(`(async()=>{${W};return w.webContents.executeJavaScript(${JSON.stringify(code)})})()`)
  const results = {}
  for (const [name, note, code] of SCENES) {
    await pet(code)
    await pet(`window.pet && (window.__battery = ${name === 'battery'}); PetAnimator.setIdleMotion?.(true); PetAnimator.setLowPower?.(${name === 'battery'})`)
    await sleep(1500)
    await pet('window.__raf=0; if(!window.__rafWrapped){const o=window.requestAnimationFrame;window.requestAnimationFrame=f=>{window.__raf++;return o(f)};window.__rafWrapped=true}')
    const file = await ev(`(async()=>{${W};await contentTracing.startRecording({included_categories:['viz']});await new Promise(r=>setTimeout(r,${seconds * 1000}));return contentTracing.stopRecording()})()`)
    const raf = await pet('window.__raf')
    const raw = fs.readFileSync(file)
    if (process.env.FRAMES_DEBUG) console.error(file, raw.length, JSON.stringify(raw.subarray(0, 120).toString('latin1')))
    const draws = countDraws(raw)
    fs.rmSync(file, { force: true })
    results[name] = { note, framesPerSecond: +(draws / seconds).toFixed(1), rafPerSecond: +(raf / seconds).toFixed(1) }
    console.log(`${path.basename(appDir).padEnd(10)} ${name.padEnd(9)} 화면 그리기 ${String(results[name].framesPerSecond).padStart(5)}/초   rAF ${String(results[name].rafPerSecond).padStart(5)}/초`)
  }
  if (out) fs.writeFileSync(out, JSON.stringify({ app: appDir, seconds, results }, null, 2))
  await ev("process.mainModule.require('electron').app.quit()").catch(() => {})
  ws.close()
} finally {
  await sleep(500)
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  fs.rmSync(home, { recursive: true, force: true })
}
