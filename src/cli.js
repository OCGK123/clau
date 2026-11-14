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
  const p = platform === 'win32' ? path.win32 : path.posix
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
  const p = platform === 'win32' ? path.win32 : path.posix
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

function cliError(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details)
}

function isCancellation(err) {
  return err?.name === 'AbortError' || ['CANCELLED', 'ABORT_ERR', 'ERR_ABORTED'].includes(err?.code)
}

function resetTime(info, now = Date.now()) {
  if (!info || typeof info !== 'object') return null
  const raw = info.resetAt ?? info.resetsAt ?? info.reset_at ?? info.resets_at ?? info.reset_time
  let parsed = null
  if (raw != null && String(raw).trim()) {
    const number = Number(raw)
    parsed = Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : Date.parse(String(raw))
  } else if (info.retry_after != null || info.retryAfter != null) {
    const delay = Number(info.retry_after ?? info.retryAfter)
    if (Number.isFinite(delay) && delay > 0) parsed = now + delay * 1000
  }
  return Number.isFinite(parsed) && parsed > now ? parsed : null
}

function isRejectedRateLimit(info) {
  return ['rejected', 'denied', 'exceeded'].includes(String(info?.status || info?.limit_status || '').toLowerCase())
}

/** Classify failures, never successful answer text or the user's question. */
function infrastructureFailure(err, now = Date.now()) {
  if (!err || isCancellation(err)) return null
  const code = String(err.code || err.type || '').toUpperCase()
  const status = Number(err.status ?? err.statusCode)
  const text = String(err.message || err).toLowerCase()
  let kind = null
  if (/RATE.?LIMIT|QUOTA|USAGE_LIMIT|CREDIT_BALANCE/.test(code) || status === 429 || /rate.?limit|usage limit|quota (?:exceeded|exhausted)|hit (?:your|the) limit|credit balance.*(?:low|exhausted|insufficient)|사용 (?:한도|제한)|사용량.*(?:초과|한도)/.test(text)) kind = 'quota'
  else if (/AUTH|UNAUTHORIZED|NOT_LOGGED_IN|INVALID_API_KEY/.test(code) || status === 401 || /not logged in|please log[ -]?in|authentication (?:failed|required|error)|unauthorized|invalid api key|(?:no|missing) api key|api key (?:not found|missing|is required)|login required|please run.*login|oauth.*(?:expired|invalid)|로그인.*(?:필요|실패)/.test(text)) kind = 'auth'
  else if (['NO_CLAUDE', 'ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(code)) kind = 'cli'
  else if (['CLI_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code) || /(?:request|connection|response|operation) timed? ?out|timeout|timed out/.test(text)) kind = 'timeout'
  else if (['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE', 'ENOSPC', 'CLI_OUTPUT_LIMIT'].includes(code) || /out of memory|resource (?:exhausted|unavailable)|too many open files|cannot allocate memory/.test(text)) kind = 'resource'
  else if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(code) || /network (?:error|unavailable)|connection (?:failed|reset|refused)|fetch failed|unable to connect|could not connect/.test(text)) kind = 'network'
  else if (/OVERLOADED|SERVICE_UNAVAILABLE|API_ERROR|CLI_EXIT|CLI_EMPTY/.test(code) || [500, 502, 503, 504, 529].includes(status) || /(?:service|server|api) (?:unavailable|error)|overloaded|temporarily unavailable|internal server error/.test(text)) kind = 'service'
  if (!kind) return null
  const reasons = {
    quota: 'Claude Code 사용 한도에 도달했어요.', auth: 'Claude Code 로그인을 확인해야 해요.',
    cli: 'Claude Code 실행 파일을 사용할 수 없어요.', timeout: 'Claude Code의 응답 시간이 초과됐어요.',
    resource: 'Claude Code를 실행할 자원이 부족해요.', network: 'Claude Code에 연결할 수 없어요.',
    service: 'Claude Code가 일시적으로 응답하지 않아요.',
  }
  return { kind, reason: reasons[kind], resetAt: resetTime(err, now) || resetTime(err.rateLimitInfo, now) }
}

/** Bounded JSONL reader, cancellation, timeout and process-error handling shared by both providers. */
function runJsonLines({ bin, name, args, cwd, prompt, onMessage, finish, failure, cleanup, timeoutMs = 180_000 }, deps = {}) {
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
      settle(cliError('CLI_OUTPUT_LIMIT', `${name}의 응답이 너무 커서 중지했어요.`))
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
      const structured = failure?.()
      if (structured) throw structured
      if (code !== 0) throw cliError('CLI_EXIT', errOut.trim() || `${name}가 대답을 끝내지 못했어요 (종료 ${code ?? signal}).`, { exitCode: code, signal })
      settle(null, finish())
    } catch (err) { settle(err) }
    dispose()
  })
  child.stdin.on('error', () => { /* EPIPE is reported by exit/error above. */ })
  child.stdin.end(prompt)
  timer = setTimeout(() => {
    settle(cliError('CLI_TIMEOUT', `${name}의 응답 시간이 길어 중지했어요. 로그인과 연결 상태를 확인한 뒤 다시 물어봐 주세요.`))
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

module.exports = { findExecutable, commandFor, runJsonLines, rejected, cliError, isCancellation, resetTime, isRejectedRateLimit, infrastructureFailure }
