const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { findExecutable, commandFor, runJsonLines } = require('../src/cli')
const claude = require('../src/claude')
const codex = require('../src/codex')
const chat = require('../src/chat')

const cfg = { persona: '짧고 친근하게 말해.', noEmoji: true, model: 'claude-test', codexModel: '', chatProvider: 'codex', chatEnabled: true }
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const item = (text, type = 'item.completed', id = 'answer-1') => ({ type, item: { id, type: 'agent_message', text } })

function fixture() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => { child.killed = true; return true }
  let stdin = ''
  child.stdin.on('data', chunk => { stdin += chunk })
  const calls = []
  const removed = []
  const deps = {
    spawn: (...args) => { calls.push(args); return child },
    findCodex: () => '/fake/codex', findClaude: () => '/fake/claude',
    mkdtempSync: () => '/tmp/clau-test-isolated',
    rmSync: (...args) => removed.push(args),
  }
  return {
    child, deps, calls, removed,
    input: () => stdin,
    emit: msg => child.stdout.write(JSON.stringify(msg) + '\n'),
    close: (code = 0) => child.emit('close', code),
  }
}

// No network or logged-in model calls: fixtures exercise each provider's process protocol.
test('Codex forwards only agent messages and deduplicates cumulative updates', async () => {
  const f = fixture()
  const deltas = []
  const task = codex.ask({ question: '안녕!', history: [{ q: '이름은?', a: '클로야.' }], cfg, onDelta: (...args) => deltas.push(args) }, f.deps)
  f.emit({ type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'private' } })
  f.emit(item('안녕', 'item.updated'))
  f.emit(item('안녕!'))
  f.emit(item('안녕!'))
  f.emit({ type: 'turn.completed', usage: {} })
  f.close()
  assert.deepEqual(await task.done, { text: '안녕!' })
  assert.deepEqual(deltas, [['안녕', '안녕'], ['!', '안녕!']])
  assert.match(f.input(), /사용자: 이름은\?\n클로: 클로야\./)
  assert.match(f.input(), /안녕!/)
  assert.equal(f.calls[0][2].cwd, '/tmp/clau-test-isolated')
  assert.equal(f.calls[0][2].shell, false)
  assert.equal(f.removed.length, 1)
})

test('Codex JSONL tolerates chunk boundaries and a final line without newline', async () => {
  const f = fixture()
  const task = codex.ask({ question: 'hello', cfg }, f.deps)
  const data = JSON.stringify(item('반가워'))
  f.child.stdout.write('not JSON\n' + data.slice(0, 21))
  f.child.stdout.write(data.slice(21))
  f.close()
  assert.deepEqual(await task.done, { text: '반가워' })
})

test('Codex failures, no answer, subprocess failures and missing binary reject', async t => {
  await t.test('turn failed', async () => {
    const f = fixture()
    const task = codex.ask({ question: 'hi', cfg }, f.deps)
    f.emit({ type: 'turn.failed', error: { message: 'Please login' } })
    f.close()
    await assert.rejects(task.done, /Please login/)
  })
  await t.test('empty', async () => {
    const f = fixture()
    const task = codex.ask({ question: 'hi', cfg }, f.deps)
    f.emit({ type: 'turn.completed' })
    f.close()
    await assert.rejects(task.done, /답 없이/)
  })
  await t.test('failed exit after partial text is not a completed answer', async () => {
    const f = fixture()
    const task = codex.ask({ question: 'hi', cfg }, f.deps)
    f.emit(item('partial'))
    f.child.stderr.write('authentication failed')
    f.close(1)
    await assert.rejects(task.done, /authentication failed/)
  })
  await t.test('spawn error', async () => {
    const f = fixture()
    const task = codex.ask({ question: 'hi', cfg }, f.deps)
    f.child.emit('error', new Error('ENOENT'))
    await assert.rejects(task.done, /ENOENT/)
    assert.equal(f.removed.length, 1)
  })
  await t.test('missing binary', async () => {
    await assert.rejects(codex.ask({ question: 'hi', cfg }, { findCodex: () => null }).done, { code: 'NO_CODEX' })
  })
})

test('transient Codex error can recover with turn.completed', async () => {
  const f = fixture()
  const task = codex.ask({ question: 'hi', cfg }, f.deps)
  f.emit({ type: 'error', message: 'Reconnecting' })
  f.emit(item('I am here'))
  f.emit({ type: 'turn.completed' })
  f.close()
  assert.equal((await task.done).text, 'I am here')
})

test('cancel promptly rejects, stops deltas, kills process and cleans on close', async () => {
  const f = fixture()
  let updates = 0
  const task = codex.ask({ question: 'hi', cfg, onDelta: () => updates++ }, f.deps)
  task.cancel()
  f.emit(item('late answer'))
  await assert.rejects(task.done, { code: 'CANCELLED', name: 'AbortError' })
  assert.equal(f.child.killed, true)
  assert.equal(updates, 0)
  f.close(null)
  assert.equal(f.removed.length, 1)
})

test('Codex arguments protect user files and disable chat-side integrations', () => {
  const args = codex.buildArgs(cfg)
  for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(args.includes(flag))
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  for (const value of ['features.shell_tool=false', 'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'features.multi_agent=false', 'mcp_servers={}', 'project_doc_max_bytes=0', 'web_search="disabled"']) assert.ok(args.includes(value), value)
  assert.ok(args.some(x => x.startsWith('developer_instructions=') && x.includes(cfg.persona)))
  assert.equal(args.includes('--model'), false)
  const custom = codex.buildArgs({ ...cfg, codexModel: 'test-model' })
  assert.equal(custom[custom.indexOf('--model') + 1], 'test-model')
})

test('Claude streaming, final text and rate limits retain existing contract', async () => {
  const f = fixture()
  const deltas = [], limits = []
  const task = claude.ask({ question: 'hi $(literal)', cfg, cwd: '/tmp/claude', onDelta: (...v) => deltas.push(v), onRateLimit: v => limits.push(v) }, f.deps)
  f.emit(delta('hello'))
  f.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })
  f.emit({ type: 'result', result: 'hello there', is_error: false })
  f.close()
  assert.deepEqual(await task.done, { text: 'hello there' })
  assert.deepEqual(deltas, [['hello', 'hello']])
  assert.deepEqual(limits, [{ status: 'allowed_warning' }])
  assert.equal(f.input(), 'hi $(literal)')
  assert.equal(f.calls[0][2].shell, false)
})

test('provider switch dispatches, and chat disabled never starts a subprocess', async () => {
  const f = fixture()
  const task = chat.ask({ question: 'hi', cfg: { ...cfg, chatProvider: 'claude' } }, f.deps)
  f.emit({ type: 'result', result: 'Hi' })
  f.close()
  assert.equal((await task.done).text, 'Hi')
  assert.equal(f.calls[0][0], '/fake/claude')
  const disabled = fixture()
  await assert.rejects(chat.ask({ question: 'hi', cfg: { ...cfg, chatEnabled: false } }, disabled.deps).done, { code: 'CHAT_DISABLED' })
  assert.equal(disabled.calls.length, 0)
})

test('CLI discovery honors explicit missing paths instead of using another provider installation', () => {
  const options = { platform: 'linux', home: '/home/test', env: { PATH: '/bin:/apps' }, isFile: file => file === '/apps/codex' }
  assert.equal(findExecutable('codex', '', options), '/apps/codex')
  assert.equal(findExecutable('codex', '/missing/custom', options), null)
})

test('Windows official npm shims run with Node without cmd.exe parsing', () => {
  const bin = 'C:\\Users\\a b\\AppData\\Roaming\\npm\\codex.cmd'
  const entry = 'C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
  const command = commandFor(bin, 'codex', { platform: 'win32', node: 'electron.exe', exists: value => value === entry })
  assert.deepEqual(command, { bin: 'electron.exe', prefix: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } })
  assert.throws(() => commandFor(bin, 'codex', { platform: 'win32', exists: () => false }), /공식 CLI/)
})

test('oversized output and timeout stop a runaway child', async t => {
  await t.test('oversized', async () => {
    const f = fixture()
    const task = runJsonLines({ bin: 'codex', name: 'codex', args: [], prompt: '', onMessage() {}, finish() {} }, f.deps)
    f.child.stdout.write('x'.repeat(1_048_577))
    await assert.rejects(task.done, /너무 커서/)
    assert.equal(f.child.killed, true)
    f.close(null)
  })
  await t.test('timeout', async () => {
    const f = fixture()
    const task = runJsonLines({ bin: 'codex', name: 'codex', args: [], prompt: '', onMessage() {}, finish() {}, timeoutMs: 5 }, f.deps)
    const keepAlive = setTimeout(() => {}, 100)
    try { await assert.rejects(task.done, /응답 시간이/) } finally { clearTimeout(keepAlive) }
    assert.equal(f.child.killed, true)
    f.close(null)
  })
})
