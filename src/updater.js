// 업데이트: GitHub 릴리스에 올라온 새 판을 받아 지금 설치된 자리에 바꿔 넣는다.
//   1. releases/latest/download/latest.json 에서 새 판 번호와 파일별 sha256을 읽는다 (API 호출 한도와 무관)
//   2. 이 컴퓨터용 zip을 설치 폴더 옆에 받아 sha256을 맞춰 보고 푼다
//   3. 클로가 꺼지면 폴더를 바꿔치기하고 다시 켜는 작은 스크립트를 남기고 물러난다
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { extract } = require('./unzip')

const fsp = fs.promises
const TARGETS = {
  'linux-x64': 'linux-x64',
  'win32-x64': 'windows-x64',
  'darwin-arm64': 'mac-apple-silicon',
  'darwin-x64': 'mac-intel',
}
const MAX_ZIP_BYTES = 600 * 1024 * 1024

const fail = (code, message) => Object.assign(new Error(message), { code })

/** 'OCGK123/clau' 꼴. package.json의 repository에서 읽는다. */
function repoSlug(pkg) {
  const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url || ''
  const found = /(?:github:|github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(raw.trim())
  return found ? found[1] : null
}

const parts = version => String(version).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
function newer(candidate, current) {
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return false
}

const targetName = (platform = process.platform, arch = process.arch) => TARGETS[`${platform}-${arch}`] || null

/** 설치된 자리. 맥은 .app 묶음, 나머지는 실행 파일이 든 폴더. */
function installDir(execPath, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  return platform === 'darwin' ? p.resolve(execPath, '..', '..', '..') : p.dirname(execPath)
}

/** zip 안에서 새 앱이 놓인 자리 (build.mjs가 만든 모양). */
const unpackedApp = (stage, target, platform = process.platform) =>
  path.join(stage, 'unpacked', `Clau-${target}`, 'Clau', ...(platform === 'darwin' ? ['Clau.app'] : []))

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function check({ repo, current, target, fetch: fetcher = globalThis.fetch, timeoutMs = 15_000 }) {
  if (!repo) throw fail('NO_REPO', '업데이트를 받을 곳을 몰라요.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let latest
  try {
    const response = await fetcher(`https://github.com/${repo}/releases/latest/download/latest.json`, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (response.status === 404) return { version: current, available: false, page: `https://github.com/${repo}/releases` }
    if (!response.ok) throw fail('UPDATE_HTTP', `GitHub가 ${response.status}로 답했어요.`)
    latest = await response.json()
  } catch (err) {
    if (err?.code) throw err
    throw fail('UPDATE_OFFLINE', 'GitHub에 연결하지 못했어요.')
  } finally {
    clearTimeout(timer)
  }
  const version = typeof latest?.version === 'string' && /^\d+\.\d+\.\d+$/.test(latest.version) ? latest.version : null
  if (!version) throw fail('UPDATE_FORMAT', '릴리스 정보를 읽지 못했어요.')
  const name = target ? `Clau-${target}.zip` : null
  const file = name ? latest.files?.[name] : null
  const usable = !!file && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_ZIP_BYTES
  return {
    version,
    available: newer(version, current),
    notes: typeof latest.notes === 'string' ? latest.notes.slice(0, 4000) : '',
    page: `https://github.com/${repo}/releases/tag/v${version}`,
    file: usable ? { name, sha256: file.sha256, size: file.size, url: `https://github.com/${repo}/releases/download/v${version}/${name}` } : null,
  }
}

/** 받으면서 sha256을 같이 센다. 맞지 않으면 파일을 남기지 않는다. */
async function download(file, dest, { fetch: fetcher = globalThis.fetch, onProgress, signal } = {}) {
  const response = await fetcher(file.url, { signal })
  if (!response.ok || !response.body) throw fail('UPDATE_HTTP', `내려받지 못했어요 (${response.status}).`)
  const hash = crypto.createHash('sha256')
  const out = fs.createWriteStream(dest)
  let got = 0
  try {
    for await (const chunk of response.body) {
      got += chunk.byteLength
      if (got > file.size) throw fail('UPDATE_SIZE', '받은 파일이 올라온 것보다 커요.')
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
      onProgress?.(got / file.size)
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())))
    if (got !== file.size || hash.digest('hex') !== file.sha256) throw fail('UPDATE_CHECKSUM', '받은 파일이 올라온 것과 달라요. 잠시 뒤 다시 해 주세요.')
  } catch (err) {
    out.destroy()
    await fsp.rm(dest, { force: true })
    throw err
  }
}

const SWAP_SH = `#!/bin/sh
# 클로가 꺼지기를 기다렸다가 새 판으로 바꾸고 다시 켠다.
pid="$1"; new="$2"; dest="$3"; stage="$4"; mac="$5"
n=0
while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 150 ]; do sleep 0.1; n=$((n + 1)); done
old="$dest.old"
rm -rf "$old"
if mv "$dest" "$old" && mv "$new" "$dest"; then
  rm -rf "$old"
elif [ ! -e "$dest" ]; then
  mv "$old" "$dest"
fi
rm -rf "$stage"
if [ "$mac" = 1 ]; then
  xattr -cr "$dest" 2>/dev/null
  codesign --force --deep --sign - "$dest" >/dev/null 2>&1
  exec open "$dest"
fi
exec "$dest/clau"
`

const SWAP_PS1 = `param([int]$ProcId, [string]$New, [string]$Dest, [string]$Stage)
# 클로가 꺼지기를 기다렸다가 새 판으로 바꾸고 다시 켠다.
try { Wait-Process -Id $ProcId -Timeout 20 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 400
robocopy $New $Dest /MIR /NFL /NDL /NJH /NJS /NP /R:10 /W:1 | Out-Null
Start-Process -FilePath (Join-Path $Dest 'clau.exe')
Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
`

/**
 * 받은 새 판을 설치 폴더 옆(같은 디스크)에 풀어 둔다. 바꿔치기가 한순간에 끝나도록.
 * 돌려주는 것: 이어서 swap()에 넘길 정보.
 */
async function stage(update, { execPath = process.execPath, platform = process.platform, target = targetName(), fetch: fetcher, onProgress, signal } = {}) {
  if (!update?.file) throw fail('UPDATE_NO_FILE', '이 컴퓨터용 파일이 릴리스에 없어요.')
  const dest = installDir(execPath, platform)
  const root = path.join(path.dirname(dest), '.clau-update')
  if (!writable(path.dirname(dest)) || !writable(dest)) throw fail('UPDATE_READONLY', '설치된 폴더를 바꿀 권한이 없어요.')
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.mkdir(root, { recursive: true })
  try {
    const zip = path.join(root, update.file.name)
    await download(update.file, zip, { fetch: fetcher, signal, onProgress: ratio => onProgress?.('download', ratio) })
    await extract(zip, path.join(root, 'unpacked'), { platform, onProgress: ratio => onProgress?.('unpack', ratio) })
    await fsp.rm(zip, { force: true })
    const fresh = unpackedApp(root, target, platform)
    const binary = platform === 'darwin' ? path.join(fresh, 'Contents', 'MacOS', 'clau') : path.join(fresh, platform === 'win32' ? 'clau.exe' : 'clau')
    if (!fs.existsSync(binary)) throw fail('UPDATE_LAYOUT', '받은 파일 안에서 클로를 찾지 못했어요.')
    return { root, fresh, dest }
  } catch (err) {
    await fsp.rm(root, { recursive: true, force: true })
    throw err
  }
}

/** 바꿔치기 스크립트를 띄운다. 부른 쪽은 곧바로 앱을 끝내야 한다. */
function swap({ root, fresh, dest }, { pid = process.pid, platform = process.platform, run = spawn } = {}) {
  if (platform === 'win32') {
    const script = path.join(root, 'swap.ps1')
    fs.writeFileSync(script, SWAP_PS1)
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-ProcId', String(pid), '-New', fresh, '-Dest', dest, '-Stage', root],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  const script = path.join(root, 'swap.sh')
  fs.writeFileSync(script, SWAP_SH, { mode: 0o755 })
  run('/bin/sh', [script, String(pid), fresh, dest, root, platform === 'darwin' ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref()
}

module.exports = { check, download, stage, swap, newer, repoSlug, targetName, installDir, unpackedApp, writable, SWAP_SH, SWAP_PS1 }
