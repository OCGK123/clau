// CLI 실행은 셸을 거치지 않는다. 질문·성격에 들어 있는 기호도 그대로 전달한다.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const NPM_ENTRIES = {
  claude: ['@anthropic-ai', 'claude-code', 'cli.js'],
  codex: ['@openai', 'codex', 'bin', 'codex.js'],
}

function findExecutable(name, custom, options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const p = platform === 'win32' ? path.win32 : path
  const isFile = options.isFile || (file => {
    try {
      if (!fs.statSync(file).isFile()) return false
      if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch { return false }
  })
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name]
  const dirs = [
    ...(env.PATH || '').split(platform === 'win32' ? ';' : ':'),
    p.join(home, '.local', 'bin'),
    p.join(home, `.${name}`, 'local'),
    p.join(home, `.${name}`, 'bin'),
    '/usr/local/bin', '/opt/homebrew/bin',
    p.join(home, '.npm-global', 'bin'),
    ...(platform === 'win32' && env.APPDATA ? [p.join(env.APPDATA, 'npm')] : []),
  ].filter(Boolean)
  // An explicit path is authoritative: don't silently run a different installation.
  if (typeof custom === 'string' && custom.trim()) return isFile(custom.trim()) ? custom.trim() : null
  for (const dir of dirs) for (const executable of names) {
    const candidate = p.join(dir, executable)
    if (isFile(candidate)) return candidate
  }
  return null
}

function commandFor(bin, name, options = {}) {
  const platform = options.platform || process.platform
  const p = platform === 'win32' ? path.win32 : path
  const exists = options.exists || fs.existsSync
  const node = options.node || process.execPath
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    // Official npm shims have a known JS entry beside them. Run that entry with
    // Node (or Electron's Node mode) instead of letting cmd.exe parse user text.
    const entry = NPM_ENTRIES[name]
    const script = entry && p.join(p.dirname(bin), 'node_modules', ...entry)
    if (!script || !exists(script)) {
      throw new Error(`${name}의 npm 실행 파일을 찾지 못했어요. 설정에 ${name}.exe 경로를 지정하거나 공식 CLI를 다시 설치해 주세요.`)
    }
    return { bin: node, prefix: [script], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  if (/\.(m?js|cjs)$/i.test(bin)) return { bin: node, prefix: [bin], env: { ELECTRON_RUN_AS_NODE: '1' } }
  return { bin, prefix: [], env: {} }
}

function rejected(err) {
  return { done: Promise.reject(err), cancel() {} }
}

/** Bounded JSONL reader, cancellation, timeout and process-error handling shared by both providers. */
function runJsonLines({ bin, name, args, cwd, prompt, onMessage, finish, cleanup, timeoutMs = 180_000 }, deps = {}) {
  let command, child
  try {
    command = commandFor(bin, name, deps)
    child = (deps.spawn || spawn)(command.bin, [...command.prefix, ...args], {
      cwd, windowsHide: true, shell: false,
      env: { ...process.env, ...command.env, CLAU_CHAT: '1' },
    })
  } catch (err) {
    cleanup?.()
    return rejected(err)
  }

  let buffer = ''
  let errOut = ''
  let settled = false
  let ended = false
  let cleaned = false
  let settle
  let timer
  const dispose = () => {
    if (cleaned) return
    cleaned = true
    cleanup?.()
  }
  const done = new Promise((resolve, reject) => {
    settle = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value)
    }
  })
  const kill = () => {
    if (ended) return
    try { child.kill() } catch { /* already closed */ }
  }
  const handle = line => {
    if (!line || settled) return
    let msg
    try { msg = JSON.parse(line) } catch { return }
    try { onMessage(msg) } catch (err) { settle(err); kill() }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    if (settled) return
    buffer += chunk
    if (buffer.length > 1_048_576) {
      settle(new Error(`${name}의 응답이 너무 커서 중지했어요.`))
      kill()
      return
    }
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      handle(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { errOut = (errOut + chunk).slice(-3000) })
  child.on('error', err => {
    ended = true
    settle(err)
    dispose()
  })
  child.on('close', (code, signal) => {
    ended = true
    handle(buffer.trim())
    try {
      if (code !== 0) throw new Error(errOut.trim() || `${name}가 대답을 끝내지 못했어요 (종료 ${code ?? signal}).`)
      settle(null, finish())
    } catch (err) { settle(err) }
    dispose()
  })
  child.stdin.on('error', () => { /* EPIPE is reported by exit/error above. */ })
  child.stdin.end(prompt)
  timer = setTimeout(() => {
    settle(new Error(`${name}의 응답 시간이 길어 중지했어요. 로그인과 연결 상태를 확인한 뒤 다시 물어봐 주세요.`))
    kill()
  }, timeoutMs)
  timer.unref?.()
  return {
    done,
    cancel() {
      const err = new Error('대화를 중지했어요.')
      err.name = 'AbortError'
      err.code = 'CANCELLED'
      settle(err)
      kill()
    },
  }
}

module.exports = { findExecutable, commandFor, runJsonLines, rejected }
