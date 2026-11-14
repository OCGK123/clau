// Claude Code(mod)가 클로에게 말을 거는 작은 창구. 이 컴퓨터 안(127.0.0.1)에서만 열리고, 열쇠(token)를 아는
// mod만 쓸 수 있다. 열쇠와 번호(port)는 ~/.claude/clau/app.json 에 적어 두고(나만 읽을 수 있게), mod가 읽는다.
//
//   POST /notify  { kind: 'done' | 'limit', session, project, resetsAt? }            → 204
//   POST /ask     { id, kind: 'permission' | 'question' | 'plan', session, project, tool, input, suggestions }
//                 → 고를 때까지(최대 WAIT_MS) 붙잡고 있다가 { state: 'answered', answer } | { state: 'pending' } | { state: 'pass' }
//                 pending이면 mod가 같은 id로 다시 묻는다. pass면 Claude Code가 늘 하던 대로 직접 묻는다.
//   POST /cancel  { id }  Claude Code 쪽에서 먼저 끝났다(취소 등) → 말풍선을 거둔다.
//
// 클로가 안 보일 때(Claude 창이 뒤에 있을 때)는 바로 pass 한다: 그 사이 Claude Code의 창이 막혀 있지 않도록.
const http = require('node:http')
const crypto = require('node:crypto')

const WAIT_MS = 20_000 // 한 번 붙잡고 있는 시간. mod는 pending을 받으면 다시 묻는다.
const ASK_TIMEOUT_MS = 3 * 60_000 // 이만큼 아무도 안 고르면 Claude Code에게 돌려준다.
const MAX_BODY = 256 * 1024

function create({ canAsk = () => true, onNotify = () => {}, onAsk = () => {}, onCancel = () => {}, waitMs = WAIT_MS, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  const token = crypto.randomBytes(24).toString('hex')
  const asks = new Map() // id → { info, answer, waiters: Set<fn>, timer }
  let port = 0

  function settle(id, result) {
    const ask = asks.get(id)
    if (!ask || ask.result) return false
    ask.result = result
    clearTimeout(ask.timer)
    for (const reply of ask.waiters) reply(result)
    ask.waiters.clear()
    // 늦게 다시 묻는 mod도 답을 받을 수 있게 잠깐 남겨 둔다.
    setTimeout(() => asks.delete(id), 60_000).unref?.()
    return true
  }

  function wait(ask, res) {
    if (ask.result) return send(res, 200, ask.result)
    let done = false
    const reply = result => {
      if (done) return
      done = true
      clearTimeout(timer)
      ask.waiters.delete(reply)
      send(res, 200, result)
    }
    const timer = setTimeout(() => reply({ state: 'pending' }), waitMs)
    ask.waiters.add(reply)
    // mod가 기다리다 끊으면(사용자가 Claude Code에서 Esc 등) 기다리는 쪽만 지운다. 취소는 /cancel 이 알린다.
    res.on('close', () => { if (!done) { done = true; clearTimeout(timer); ask.waiters.delete(reply) } })
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.headers['x-clau-token'] !== token) return send(res, 403, { error: 'forbidden' })
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return send(res, 400, { error: 'bad json' }) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'bad body' })
      if (req.url === '/notify') {
        if (!['done', 'limit'].includes(body.kind)) return send(res, 400, { error: 'kind' })
        try { onNotify(body) } catch {}
        return send(res, 204)
      }
      if (req.url === '/cancel') {
        const id = String(body.id || '')
        if (!id) return send(res, 400, { error: 'id' })
        // Cancellation can arrive before the in-flight /ask. Keep its id briefly
        // so a delayed request cannot reopen an abandoned permission prompt.
        if (!asks.has(id)) asks.set(id, { info: { id }, result: null, waiters: new Set(), timer: null })
        if (settle(id, { state: 'pass' })) {
          try { onCancel(id) } catch {}
        }
        return send(res, 204)
      }
      if (req.url === '/ask') {
        const id = String(body.id || '')
        if (!id || !['permission', 'question', 'plan'].includes(body.kind)) return send(res, 400, { error: 'ask' })
        let ask = asks.get(id)
        if (!ask) {
          // 클로가 지금 보이지 않으면 기다리게 하지 않는다.
          if (!canAsk(body)) return send(res, 200, { state: 'pass' })
          ask = { info: body, result: null, waiters: new Set(), timer: null }
          asks.set(id, ask)
          ask.timer = setTimeout(() => { if (settle(id, { state: 'pass' })) try { onCancel(id) } catch {} }, timeoutMs)
          ask.timer.unref?.()
          try { onAsk(body) } catch { settle(id, { state: 'pass' }) }
        }
        return wait(ask, res)
      }
      send(res, 404, { error: 'not found' })
    })
  })
  server.keepAliveTimeout = 1000

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      resolve(port)
    })
  })

  return {
    ready,
    token,
    get port() { return port },
    /** 말풍선에서 고른 답을 기다리는 mod에게 돌려준다. */
    answer: (id, answer) => settle(String(id), answer && answer.choice !== 'pass' ? { state: 'answered', answer } : { state: 'pass' }),
    /** 아직 답을 기다리는 질문들. */
    pending: () => [...asks.entries()].filter(([, a]) => !a.result).map(([id, a]) => ({ id, ...a.info })),
    close() {
      for (const id of asks.keys()) settle(id, { state: 'pass' })
      server.close()
      server.closeAllConnections?.()
    },
  }
}

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return
  if (status === 204) { res.writeHead(204); return res.end() }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 말풍선에 보일 내용: 무엇을 고르는지와 선택지. 원래 입력은 mod가 들고 있다. */
function describe(ask) {
  const input = ask.input && typeof ask.input === 'object' ? ask.input : {}
  const from = ask.project ? `Claude Code · ${ask.project}` : 'Claude Code'
  const text = value => String(value ?? '')
  const json = value => JSON.stringify(value, null, 2)
  if (ask.kind === 'question') {
    const questions = (Array.isArray(input.questions) ? input.questions : []).map(q => ({
      question: text(q?.question),
      key: String(q?.question ?? ''),
      header: text(q?.header),
      multi: !!q?.multiSelect,
      options: (Array.isArray(q?.options) ? q.options : []).map(o => ({ label: text(o?.label), value: text(o?.label), hint: text(o?.description) })),
    })).filter(q => q.key && q.options.length)
    return { id: ask.id, kind: 'question', from, questions }
  }
  if (ask.kind === 'plan') {
    // Without the actual plan, the native Claude Code dialog is the place to approve it.
    return { id: ask.id, kind: 'plan', from, title: '계획대로 시작할까요?', detail: json(input), canApprove: typeof input.plan === 'string' && !!input.plan.trim() }
  }
  const tool = String(ask.tool || '')
  const file = String(input.file_path || input.notebook_path || input.path || '')
  let title = `${tool} 써도 될까요?`
  let detail = ''
  if (tool === 'Bash' || tool === 'PowerShell') { title = '이 명령을 실행해도 될까요?'; detail = text(input.command) }
  else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) { title = tool === 'Write' ? '이 파일을 써도 될까요?' : '이 파일을 고쳐도 될까요?'; detail = file }
  else if (tool === 'Read') { title = '이 파일을 읽어도 될까요?'; detail = file }
  else if (tool === 'WebFetch') { title = '이 주소를 열어 봐도 될까요?'; detail = text(input.url) }
  else if (tool === 'WebSearch') { title = '검색해 봐도 될까요?'; detail = text(input.query) }
  else if (tool.startsWith('mcp__')) { const [, server, name] = tool.split('__'); title = `${server}의 ${name || '도구'} 써도 될까요?` }
  // Every argument stays available before approval, including write content, MCP arguments,
  // command tails and the exact persistent permission scope. The view scrolls this text.
  const summaryKey = tool === 'Bash' || tool === 'PowerShell' ? 'command'
    : tool === 'WebFetch' ? 'url' : tool === 'WebSearch' ? 'query'
      : file ? (input.file_path ? 'file_path' : input.notebook_path ? 'notebook_path' : 'path') : null
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== summaryKey))
  if (Object.keys(rest).length) detail += `${detail ? '\n\n' : ''}${json(rest)}`
  if (typeof ask.description === 'string' && ask.description) detail += `${detail ? '\n\n' : ''}${ask.description}`
  if (typeof ask.cwd === 'string' && ask.cwd) detail += `\n\n작업 폴더: ${ask.cwd}`
  const always = !!(Array.isArray(ask.suggestions) && ask.suggestions.length)
  if (always) detail += `\n\n다음부터 묻지 않기 범위:\n${json(ask.suggestions)}`
  return { id: ask.id, kind: 'permission', from, title, detail, mono: true, always, canApprove: !!detail }

}

module.exports = { create, describe, WAIT_MS, ASK_TIMEOUT_MS }
