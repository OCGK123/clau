const test = require('node:test')
const assert = require('node:assert/strict')
const notices = require('../src/notices')

const post = async (server, path, body, token = server.token) => {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', headers: { 'x-clau-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

test('only the mod that knows the key can talk to the pet', async () => {
  const server = notices.create()
  await server.ready
  assert.equal((await post(server, '/notify', { kind: 'done' }, 'wrong')).status, 403)
  const seen = []
  server.close()
  const other = notices.create({ onNotify: n => seen.push(n.kind) })
  await other.ready
  assert.equal((await post(other, '/notify', { kind: 'done', session: 's' })).status, 204)
  assert.equal((await post(other, '/notify', { kind: 'limit', session: 's' })).status, 204)
  assert.equal((await post(other, '/notify', { kind: 'nope' })).status, 400)
  assert.deepEqual(seen, ['done', 'limit'])
  other.close()
})

test('a question waits for the bubble and hands back exactly what was picked', async () => {
  const shown = []
  const server = notices.create({ onAsk: a => shown.push(a.id) })
  await server.ready
  const pending = post(server, '/ask', { id: 'a1', kind: 'permission', tool: 'Bash', input: { command: 'ls' } })
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(shown, ['a1'])
  assert.deepEqual(server.pending().map(a => a.id), ['a1'])
  server.answer('a1', { choice: 'allow' })
  assert.deepEqual((await pending).body, { state: 'answered', answer: { choice: 'allow' } })
  // 늦게 다시 물어도 같은 답
  assert.deepEqual((await post(server, '/ask', { id: 'a1', kind: 'permission' })).body.state, 'answered')
  assert.equal(shown.length, 1, 'asking again never shows the bubble twice')
  server.close()
})

test('a long wait comes back as pending, then the mod asks again and gets the answer', async () => {
  const server = notices.create({ waitMs: 40 })
  await server.ready
  assert.deepEqual((await post(server, '/ask', { id: 'q', kind: 'question', input: {} })).body, { state: 'pending' })
  const again = post(server, '/ask', { id: 'q', kind: 'question', input: {} })
  setTimeout(() => server.answer('q', { choice: 'answers', answers: { 'Which?': 'A' } }), 10)
  assert.deepEqual((await again).body, { state: 'answered', answer: { choice: 'answers', answers: { 'Which?': 'A' } } })
  server.close()
})

test('a hidden pet passes at once, cancel and timeout hand the choice back to Claude Code', async () => {
  let visible = false
  const cancelled = []
  const server = notices.create({ canAsk: () => visible, onCancel: id => cancelled.push(id), timeoutMs: 80 })
  await server.ready
  assert.deepEqual((await post(server, '/ask', { id: 'h', kind: 'permission' })).body, { state: 'pass' })
  visible = true
  const waiting = post(server, '/ask', { id: 'c', kind: 'permission' })
  await new Promise(r => setTimeout(r, 20))
  await post(server, '/cancel', { id: 'c' })
  assert.deepEqual((await waiting).body, { state: 'pass' })
  assert.deepEqual(cancelled, ['c'])
  assert.deepEqual((await post(server, '/ask', { id: 't', kind: 'plan' })).body, { state: 'pass' }, 'times out')
  assert.deepEqual(cancelled, ['c', 't'])
  // "Claude Code에서 고를래요"
  const p = post(server, '/ask', { id: 'p', kind: 'permission' })
  await new Promise(r => setTimeout(r, 20))
  server.answer('p', { choice: 'pass' })
  assert.deepEqual((await p).body, { state: 'pass' })
  server.close()
})

test('the bubble shows a short, human summary of what is being asked', () => {
  const bash = notices.describe({ id: '1', kind: 'permission', project: 'clau', tool: 'Bash', input: { command: 'npm test' }, suggestions: [{ type: 'addRules' }] })
  assert.equal(bash.title, '이 명령을 실행해도 될까요?')
  assert.ok(bash.detail.startsWith('npm test\n'))
  assert.equal(bash.from, 'Claude Code · clau')
  assert.equal(bash.always, true)
  const edit = notices.describe({ id: '2', kind: 'permission', tool: 'Edit', input: { file_path: '/home/me/app/src/main.js' } })
  assert.equal(edit.detail, '/home/me/app/src/main.js')
  assert.equal(edit.always, false)
  const q = notices.describe({ id: '3', kind: 'question', input: { questions: [{ question: 'Which fruit?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: 'red' }, { label: 'Banana', description: 'yellow' }] }] } })
  assert.equal(q.questions[0].options[1].value, 'Banana')
  assert.equal(q.questions[0].key, 'Which fruit?')
  const mcp = notices.describe({ id: '4', kind: 'permission', tool: 'mcp__github__create_issue', input: {} })
  assert.equal(mcp.title, 'github의 create_issue 써도 될까요?')
})

test('approval details retain full commands, write contents, paths and persistent permission scope', () => {
  const command = `echo ${'a'.repeat(400)} && npm run build`
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }], behavior: 'allow', destination: 'localSettings' }]
  const bash = notices.describe({ id: 'long', kind: 'permission', tool: 'Bash', input: { command, timeout: 30000 }, cwd: '/work/project', suggestions })
  assert.ok(bash.detail.includes(command))
  assert.ok(bash.detail.includes('30000'))
  assert.ok(bash.detail.includes('/work/project'))
  assert.ok(bash.detail.includes(JSON.stringify(suggestions, null, 2)))
  const content = `first\n${'write content '.repeat(60)}\nlast`
  const write = notices.describe({ id: 'write', kind: 'permission', tool: 'Write', input: { file_path: '/a/b/settings.json', content } })
  assert.ok(write.detail.includes('/a/b/settings.json'))
  assert.ok(write.detail.includes(JSON.stringify(content)))
  const mcp = notices.describe({ id: 'mcp', kind: 'permission', tool: 'mcp__github__create_issue', input: { repo: 'app', title: 'Issue', body: content } })
  assert.equal(mcp.detail, JSON.stringify({ repo: 'app', title: 'Issue', body: content }, null, 2))
  const plan = 'Plan step\n'.repeat(100)
  assert.ok(notices.describe({ id: 'plan', kind: 'plan', input: { plan } }).detail.includes(JSON.stringify(plan)))
  assert.equal(notices.describe({ id: 'plan-empty', kind: 'plan', input: {} }).canApprove, false)
})

test('question choices and their explanations are not silently shortened or dropped', () => {
  const questions = Array.from({ length: 5 }, (_, i) => ({ question: `${i} ${'question '.repeat(60)}`, options: Array.from({ length: 7 }, (_, j) => ({ label: `${j} ${'label '.repeat(30)}`, description: 'explanation '.repeat(30) })) }))
  const view = notices.describe({ kind: 'question', input: { questions } })
  assert.equal(view.questions.length, 5)
  assert.equal(view.questions[4].question, questions[4].question)
  assert.equal(view.questions[4].options.length, 7)
  assert.equal(view.questions[4].options[6].label, questions[4].options[6].label)
  assert.equal(view.questions[4].options[6].hint, questions[4].options[6].description)
})

test('an early cancellation prevents an in-flight request from reopening its bubble', async () => {
  const shown = []
  const server = notices.create({ onAsk: ask => shown.push(ask.id) })
  await server.ready
  try {
    await post(server, '/cancel', { id: 'racing' })
    assert.deepEqual((await post(server, '/ask', { id: 'racing', kind: 'permission' })).body, { state: 'pass' })
    assert.deepEqual(shown, [])
    for (const body of [null, [], 1, 'invalid']) assert.equal((await post(server, '/notify', body)).status, 400)
  } finally { server.close() }
})

// Execute the actual hook with its SDK boundary mocked, keeping cancellation races
// in the ordinary npm test suite as well as the optional Claude mod test runner.
function permissionHook(fetch) {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  const { stripTypeScriptTypes } = require('node:module')
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../claude-mod/hooks/register.ts'), 'utf8'))
    .replace(/^import .* from ['"]claude-code['"];?\s*$/gm, '')
    .replace('export const register', 'const register')
  const hooks = new Map()
  const register = vm.runInNewContext(`${source}\nregister`, { atom: () => ({}), read: () => ({}), update: () => {}, Date })
  register((event, ...args) => { hooks.set(event, args.at(-1)); return { catch() {} } })
  const posted = []
  const $ = {
    env: { get: async key => key === 'HOME' ? '/home/test' : undefined },
    fs: { read: async () => JSON.stringify({ exec: '/clau', port: 4321, token: 'test' }) },
    http: { fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      posted.push({ url, body })
      if (url.endsWith('/cancel')) return { ok: true, text: '' }
      return fetch(url, body)
    } },
  }
  const ask = async signal => {
    const next = () => ({ native: true })
    next.signal = signal
    return hooks.get('classic.PermissionRequest')($, { tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [], session_id: 's', cwd: '/work/project' }, next)
  }
  return { ask, posted }
}

test('an already-aborted permission request never asks the bubble', async () => {
  const controller = new AbortController()
  controller.abort()
  const hook = permissionHook(() => { throw new Error('should not fetch') })
  assert.deepEqual(await hook.ask(controller.signal), { native: true })
  assert.deepEqual(hook.posted, [])
})

test('an answer racing with abort never authorizes a tool and cancels the bubble', async () => {
  const controller = new AbortController()
  let release, started
  const entered = new Promise(resolve => { started = resolve })
  const hook = permissionHook(async () => {
    started()
    return new Promise(resolve => { release = resolve })
  })
  const pending = hook.ask(controller.signal)
  await entered
  controller.abort()
  release({ ok: true, text: JSON.stringify({ state: 'answered', answer: { choice: 'allow' } }) })
  assert.deepEqual(await pending, { native: true })
  assert.ok(hook.posted.some(p => p.url.endsWith('/cancel')))
})

test('failed, malformed and exhausted permission polls cancel before using the native dialog', async () => {
  for (const mode of ['failed', 'malformed', 'exhausted']) {
    const hook = permissionHook(async () => {
      if (mode === 'failed') throw new Error('disconnected')
      return { ok: true, text: JSON.stringify(mode === 'malformed' ? { state: 'unexpected', answer: { choice: 'allow' } } : { state: 'pending' }) }
    })
    assert.deepEqual(await hook.ask(new AbortController().signal), { native: true })
    assert.ok(hook.posted.at(-1).url.endsWith('/cancel'))
    assert.equal(hook.posted.filter(p => p.url.endsWith('/ask')).length, mode === 'exhausted' ? 15 : 1)
  }
})
