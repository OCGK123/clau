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
