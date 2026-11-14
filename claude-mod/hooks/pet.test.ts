import { expect, test } from 'claude-code/testing'
import type { TurnStepResult } from 'claude-code'

test('writes what Claude is doing to the state file the pet window watches', async ($, on) => {
  const written: { path: string; mode: string; resetsAt: string | null }[] = []
  const last = () => written.at(-1)?.mode
  const tick = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  const ran: string[][] = []
  on('command.register', () => ({ value: undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ exec: '/opt/clau/clau', args: [], platform: 'linux', wake: true }) }))
  on('http.fetch', () => ({ value: { status: 204, ok: true, headers: {}, text: '' } }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('fs.write', (_, e) => {
    written.push({ path: String(e.path), ...JSON.parse(String(e.text)) })
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'thinking' as const, index: 0, text: 'hmm' }
    yield { kind: 'text' as const, index: 1, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' } as unknown as TurnStepResult
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(last()).toBe('thinking')
  // Opening the session woke the pet, detached.
  expect(ran[0]?.slice(-2)).toEqual(['/opt/clau/clau', '--hello'])
  expect(written.at(-1)?.path).toBe('/home/tester/.claude/clau/state.json')

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  await stream.next()
  await stream.next()
  await tick()
  expect(last()).toBe('talking')
  while (!(await stream.next()).done) {}
  await tick()
  expect(last()).toBe('idle')

  await $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(last()).toBe('happy')

  await $.turn.start({ text: 'stop', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(last()).toBe('oops')

  const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
  await $.session.measure({
    context: { window: 200000 } as never,
    rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }],
    changed: ['rateLimits'],
  })
  expect(last()).toBe('sleeping')
  expect(written.at(-1)?.resetsAt).toBe(resetsAt)

  // Still limited: a new turn keeps it asleep.
  const count = written.length
  await $.turn.start({ text: 'again', turnId: 't3' })
  expect(written.length).toBe(count)
})


test('tells the pet when work is done and when the usage limit is hit', async ($, on) => {
  const posted: { url: string; body: Record<string, unknown>; key?: string }[] = []
  on('command.register', () => ({ value: undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ exec: '/opt/clau/clau', platform: 'linux', wake: false, port: 4321, token: 'k', notices: true, ask: true }) }))
  on('fs.write', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('http.fetch', (_, e) => {
    posted.push({ url: e.url, body: JSON.parse(String(e.init?.body ?? '{}')), key: e.init?.headers?.['x-clau-token'] })
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 9000, isAborted: false, turnId: 't1', reason: 'answer' })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(posted.at(-1)).toEqual({ url: 'http://127.0.0.1:4321/notify', body: { kind: 'done', project: 'my-app' }, key: 'k' })

  // An interrupted turn is not "done".
  const count = posted.length
  await $.turn.start({ text: 'stop', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(posted.length).toBe(count)

  const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: ['rateLimits'] })
  expect(posted.at(-1)?.body).toEqual({ kind: 'limit', project: 'my-app', resetsAt })
  // Still limited: no second notice.
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: ['rateLimits'] })
  expect(posted.filter(p => p.body.kind === 'limit').length).toBe(1)
})

test('hands the choice made in the pet bubble back to Claude Code', async ($, on) => {
  const replies: Record<string, unknown>[] = []
  const asks: Record<string, unknown>[] = []
  on('command.register', () => ({ value: undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ exec: '/opt/clau/clau', platform: 'linux', port: 4321, token: 'k', notices: true, ask: true }) }))
  on('fs.write', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('http.fetch', (_, e) => {
    const body = JSON.parse(String(e.init?.body ?? '{}'))
    if (e.url.endsWith('/ask')) asks.push(body)
    const reply = replies.shift() ?? { state: 'pass' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Beneath the mod: Claude Code's own dialog.
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'deny', message: 'asked in Claude Code' } }))
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

  // Allowed in the bubble, after one long wait.
  replies.push({ state: 'pending' }, { state: 'answered', answer: { choice: 'allow' } })
  const allowed = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [] } as never)
  expect(allowed.decision).toEqual({ behavior: 'allow' })
  expect(asks.length).toBe(2)
  expect(asks[0]).toMatchObject({ kind: 'permission', tool: 'Bash', input: { command: 'npm test' } })
  expect(asks[1]?.id).toBe(asks[0]?.id)

  // "다음부터 묻지 않기" saves Claude Code's own suggested rule.
  const rule = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }]
  replies.push({ state: 'answered', answer: { choice: 'always' } })
  const always = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: rule } as never)
  expect(always.decision).toEqual({ behavior: 'allow', updatedPermissions: rule })

  // Denied in the bubble.
  replies.push({ state: 'answered', answer: { choice: 'deny' } })
  const denied = await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: '/x' }, permission_suggestions: [] } as never)
  expect(denied.decision).toMatchObject({ behavior: 'deny', interrupt: true })

  // A question: the answers ride back on the input, keyed by question text.
  const input = { questions: [{ question: 'Which fruit?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: '' }, { label: 'Banana', description: '' }] }] }
  replies.push({ state: 'answered', answer: { choice: 'answers', answers: { 'Which fruit?': 'Banana' } } })
  const answered = await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: input, permission_suggestions: [] } as never)
  expect(answered.decision).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which fruit?': 'Banana' } } })
  expect(asks.at(-1)?.kind).toBe('question')

  // The pet is not on screen (or "Claude Code에서 고를래요"): Claude Code asks as usual.
  replies.push({ state: 'pass' })
  const passed = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] } as never)
  expect(passed.decision).toEqual({ behavior: 'deny', message: 'asked in Claude Code' })
})

test('abandons stale bubble requests before handing a failed poll back to Claude Code', async ($, on) => {
  let mode = 'failed'
  const posted: string[] = []
  on('command.register', () => ({ value: undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ exec: '/clau', port: 4321, token: 'key' }) }))
  on('fs.write', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    posted.push(e.url)
    if (e.url.endsWith('/cancel')) return { value: { status: 204, ok: true, headers: {}, text: '' } }
    if (mode === 'failed') return { value: { status: 503, ok: false, headers: {}, text: '' } }
    const response = mode === 'malformed' ? { state: 'unknown', answer: { choice: 'allow' } } : { state: 'pending' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(response) } }
  })
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'deny', message: 'native dialog' } }))
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  for (const nextMode of ['failed', 'malformed', 'exhausted']) {
    mode = nextMode
    posted.length = 0
    const result = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [] } as never)
    expect(result.decision).toEqual({ behavior: 'deny', message: 'native dialog' })
    expect(posted.at(-1)?.endsWith('/cancel')).toBe(true)
    expect(posted.filter(url => url.endsWith('/ask')).length).toBe(mode === 'exhausted' ? 15 : 1)
  }
})
