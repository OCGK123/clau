const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const chat = require('../src/chat')
const claude = require('../src/claude')
const { cliError, infrastructureFailure, resetTime } = require('../src/cli')

const cfg = { chatEnabled: true, chatProvider: 'claude', claudeFallbackToCodex: true, model: 'test-claude', persona: 'Friendly', noEmoji: true }
const success = text => ({ done: Promise.resolve({ text }), cancel() {} })
const failure = err => ({ done: Promise.reject(err), cancel() {} })
const deferred = () => {
  let resolve, reject
  const task = { done: new Promise((yes, no) => { resolve = yes; reject = no }), cancelled: false }
  task.resolve = resolve
  task.reject = reject
  task.cancel = () => { task.cancelled = true; reject(Object.assign(cliError('CANCELLED', 'cancelled'), { name: 'AbortError' })) }
  return task
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const opts = extra => ({ question: 'hello', history: [{ q: 'name?', a: 'Clau' }], cfg, ...extra })
const isolated = providers => ({ providers, availability: new Map() })

function cliFixture() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => { child.killed = true; return true }
  return {
    child,
    deps: { findClaude: () => '/fake/claude', spawn: () => child },
    emit: msg => child.stdout.write(JSON.stringify(msg) + '\n'),
  }
}

test('successful primary keeps Claude selected and returns the actual provider', async () => {
  const seen = []
  const settings = Object.freeze({ ...cfg })
  const deps = isolated({ claude: () => success('Claude answer'), codex: () => { throw new Error('unexpected fallback') } })
  const result = await chat.ask(opts({ cfg: settings, onProvider: value => seen.push(value) }), deps).done
  assert.deepEqual(result, { text: 'Claude answer', provider: 'claude' })
  assert.deepEqual(seen, [{ provider: 'claude', fallback: false, reason: null }])
  assert.equal(settings.chatProvider, 'claude')
})

test('fallback is opt-in and never retries when Codex is the selected primary', async () => {
  let codexCalls = 0, claudeCalls = 0
  const deps = isolated({
    claude: () => { claudeCalls++; return failure(cliError('NO_CLAUDE', 'missing Claude')) },
    codex: () => { codexCalls++; return failure(cliError('NO_CODEX', 'missing Codex')) },
  })
  await assert.rejects(chat.ask(opts({ cfg: { ...cfg, claudeFallbackToCodex: false } }), deps).done, { code: 'NO_CLAUDE' })
  assert.equal(codexCalls, 0)
  await assert.rejects(chat.ask(opts({ cfg: { ...cfg, chatProvider: 'codex' } }), deps).done, { code: 'NO_CODEX' })
  assert.equal(codexCalls, 1)
  assert.equal(claudeCalls, 1)
})

test('quota fallback preserves context and routes to Codex until the exact reset', async () => {
  let now = 2_000_000_000_000
  const resetAt = now + 60_000
  let claudeCalls = 0, codexCalls = 0
  const contexts = [], notifications = []
  const original = opts({ onProvider: value => notifications.push(value) })
  const deps = {
    ...isolated({
      claude: value => {
        contexts.push(value)
        claudeCalls++
        return claudeCalls === 1 ? failure(cliError('RATE_LIMIT', 'quota exhausted', { resetAt: resetAt / 1000 })) : success('Claude recovered')
      },
      codex: value => { contexts.push(value); codexCalls++; return success('Codex answer') },
    }),
    now: () => now,
  }
  assert.deepEqual(await chat.ask(original, deps).done, { text: 'Codex answer', provider: 'codex' })
  assert.equal(claudeCalls, 1)
  assert.equal(codexCalls, 1)
  assert.equal(contexts[1].question, original.question)
  assert.equal(contexts[1].history, original.history)
  assert.equal(contexts[1].cfg.persona, original.cfg.persona)
  assert.equal(contexts[1].cfg.noEmoji, true)
  assert.equal(contexts[1].cfg.chatProvider, 'claude')
  assert.deepEqual(notifications.map(v => [v.provider, v.fallback]), [['claude', false], ['codex', true]])
  assert.match(notifications[1].reason, /사용 한도/)
  now = resetAt - 1
  assert.equal((await chat.ask(original, deps).done).provider, 'codex')
  assert.equal(claudeCalls, 1)
  now = resetAt
  assert.deepEqual(await chat.ask(original, deps).done, { text: 'Claude recovered', provider: 'claude' })
  assert.equal(claudeCalls, 2)
  assert.equal(deps.availability.size, 0)
})

test('auth, CLI, network, timeout, service and resource failures can each fail over once', async () => {
  for (const code of ['NO_CLAUDE', 'ENOENT', 'EACCES', 'AUTHENTICATION_FAILED', 'CLI_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'SERVICE_UNAVAILABLE', 'CLI_EXIT', 'ENOMEM', 'EAGAIN']) {
    let count = 0
    const deps = isolated({ claude: () => failure(cliError(code, code)), codex: () => { count++; return success('fallback') } })
    assert.deepEqual(await chat.ask(opts(), deps).done, { text: 'fallback', provider: 'codex' }, code)
    assert.equal(count, 1, code)
  }
})

test('infrastructure cooldown avoids repeated failed starts and expires after 45 seconds', async () => {
  let now = 2_000_000_000_000
  let calls = 0
  const deps = { ...isolated({ claude: () => { calls++; return failure(cliError('ECONNRESET', 'offline')) }, codex: () => success('online') }), now: () => now }
  await chat.ask(opts(), deps).done
  now += 44_999
  await chat.ask(opts(), deps).done
  assert.equal(calls, 1)
  now += 1
  await chat.ask(opts(), deps).done
  assert.equal(calls, 2)
  await chat.ask(opts({ cfg: { ...cfg, model: 'another-model' } }), deps).done
  assert.equal(calls, 3, 'another model is not stuck behind a stale availability hint')
})

test('semantic refusals and ordinary request errors do not trigger another provider', async () => {
  let secondary = 0
  for (const result of [success('I cannot help with that request.'), failure(cliError('CLAUDE_REQUEST_FAILED', 'This request is not supported.'))]) {
    const task = chat.ask(opts(), isolated({ claude: () => result, codex: () => { secondary++; return success('wrong') } }))
    if (secondary === 0) {
      try { assert.equal((await task.done).provider, 'claude') } catch (err) { assert.equal(err.code, 'CLAUDE_REQUEST_FAILED') }
    }
  }
  assert.equal(secondary, 0)
})

test('partial primary text is cleared and late primary deltas never mix with Codex', async () => {
  const primary = deferred()
  let primaryOptions
  const deltas = []
  const deps = isolated({
    claude: value => { primaryOptions = value; return primary },
    codex: value => {
      primaryOptions.onDelta('late', 'partial late')
      value.onDelta('Codex', 'Codex')
      return success('Codex')
    },
  })
  const task = chat.ask(opts({ onDelta: (...value) => deltas.push(value) }), deps)
  primaryOptions.onDelta('partial', 'partial')
  primary.reject(cliError('ECONNRESET', 'lost connection'))
  assert.equal((await task.done).text, 'Codex')
  assert.deepEqual(deltas, [['partial', 'partial'], ['', ''], ['Codex', 'Codex']])
})

test('cancellation and AbortError never cause a fallback', async () => {
  let fallbackCalls = 0
  const primary = deferred()
  const deps = isolated({ claude: () => primary, codex: () => { fallbackCalls++; return success('wrong') } })
  const task = chat.ask(opts(), deps)
  task.cancel()
  await assert.rejects(task.done, { name: 'AbortError', code: 'CANCELLED' })
  assert.equal(primary.cancelled, true)
  await tick()
  assert.equal(fallbackCalls, 0)
  const task2 = chat.ask(opts(), isolated({ claude: () => failure(Object.assign(new Error('timeout mentioned in cancelled request'), { name: 'AbortError' })), codex: () => { fallbackCalls++; return success('wrong') } }))
  await assert.rejects(task2.done, { name: 'AbortError' })
  assert.equal(fallbackCalls, 0)
})

test('cancellation inside the transition gap prevents Codex from starting', async () => {
  const primary = deferred()
  let secondary = 0, task
  task = chat.ask(opts({ onDelta: (piece, full) => { if (full === '') task.cancel() } }), isolated({ claude: () => primary, codex: () => { secondary++; return success('wrong') } }))
  primary.reject(cliError('RATE_LIMIT', 'quota exhausted'))
  await assert.rejects(task.done, { code: 'CANCELLED' })
  await tick()
  assert.equal(secondary, 0)
})

test('cancellation while Codex runs stops that provider and cannot retry again', async () => {
  const secondary = deferred()
  let calls = 0
  const task = chat.ask(opts(), isolated({ claude: () => failure(cliError('NO_CLAUDE', 'missing')), codex: () => { calls++; return secondary } }))
  await tick()
  task.cancel()
  await assert.rejects(task.done, { code: 'CANCELLED' })
  assert.equal(secondary.cancelled, true)
  assert.equal(calls, 1)
})

test('a failing secondary produces one combined actionable error', async () => {
  let calls = 0
  const task = chat.ask(opts(), isolated({ claude: () => failure(cliError('AUTHENTICATION_FAILED', 'Claude login required')), codex: () => { calls++; return failure(cliError('NO_CODEX', 'Codex missing')) } }))
  await assert.rejects(task.done, err => {
    assert.equal(err.code, 'FALLBACK_FAILED')
    assert.match(err.message, /Claude login required/)
    assert.match(err.message, /Codex missing/)
    assert.match(err.message, /로그인 상태/)
    assert.equal(err.primaryError.code, 'AUTHENTICATION_FAILED')
    assert.equal(err.fallbackError.code, 'NO_CODEX')
    return true
  })
  assert.equal(calls, 1)
})

test('rejected Claude rate events fall back immediately without forwarding sleep state', async () => {
  const f = cliFixture()
  const limits = [], providers = []
  const deps = { ...f.deps, ...isolated({ codex: () => success('Codex available') }) }
  const task = chat.ask(opts({ onRateLimit: value => limits.push(value), onProvider: value => providers.push(value) }), deps)
  const resetsAt = Math.ceil(Date.now() / 1000) + 120
  f.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } })
  assert.deepEqual(await task.done, { text: 'Codex available', provider: 'codex' })
  assert.deepEqual(limits, [])
  assert.equal(f.child.killed, true)
  assert.equal(providers.at(-1).fallback, true)
  assert.equal([...deps.availability.values()][0].until, resetsAt * 1000)
  f.child.emit('close', 1)
})

test('allowed warnings still forward and fallback-off rejected limits preserve the normal UI event', async () => {
  for (const status of ['allowed_warning', 'rejected']) {
    const f = cliFixture()
    const limits = []
    const task = chat.ask(opts({ cfg: { ...cfg, claudeFallbackToCodex: false }, onRateLimit: value => limits.push(value) }), { ...f.deps, availability: new Map() })
    f.emit({ type: 'rate_limit_event', rate_limit_info: { status } })
    if (status === 'allowed_warning') {
      f.emit({ type: 'result', result: 'hello', is_error: false })
      f.child.emit('close', 0)
      assert.equal((await task.done).provider, 'claude')
    } else {
      await assert.rejects(task.done, { code: 'RATE_LIMIT' })
      f.child.emit('close', 1)
    }
    assert.deepEqual(limits, [{ status }])
  }
})

test('structured assistant/result errors survive nonzero process exit for classification', async () => {
  const f = cliFixture()
  const task = claude.ask(opts(), f.deps)
  f.emit({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Please login again' }] } })
  f.emit({ type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['auth error'] })
  f.child.emit('close', 1)
  await assert.rejects(task.done, err => err.code === 'AUTHENTICATION_FAILED' && /Please login/.test(err.message))
})

test('reset parsing supports epoch seconds, milliseconds, ISO dates and retry-after', () => {
  const now = 2_000_000_000_000
  assert.equal(resetTime({ resetsAt: (now + 60_000) / 1000 }, now), now + 60_000)
  assert.equal(resetTime({ reset_at: now + 60_000 }, now), now + 60_000)
  assert.equal(resetTime({ resetAt: new Date(now + 60_000).toISOString() }, now), now + 60_000)
  assert.equal(resetTime({ retry_after: 60 }, now), now + 60_000)
  assert.equal(resetTime({ resetsAt: 1 }, now), null)
  assert.equal(infrastructureFailure(cliError('CLAUDE_REQUEST_FAILED', 'A semantic refusal')), null)
})

test('Groq enables the full Claude -> Codex -> Groq chain without changing the primary', async () => {
  const order = [], notifications = [], contexts = []
  const options = opts({ cfg: { ...cfg, claudeFallbackToCodex: false, groqFallbackEnabled: true }, groqApiKey: 'gsk_fake_fallback_key', onProvider: value => notifications.push(value) })
  const deps = isolated({
    claude: value => { order.push('claude'); contexts.push(value); return failure(cliError('NO_CLAUDE', 'Claude missing')) },
    codex: value => { order.push('codex'); contexts.push(value); return failure(cliError('NO_CODEX', 'Codex missing')) },
    groq: value => { order.push('groq'); contexts.push(value); return success('Groq answer') },
  })
  assert.deepEqual(await chat.ask(options, deps).done, { text: 'Groq answer', provider: 'groq' })
  assert.deepEqual(order, ['claude', 'codex', 'groq'])
  assert.deepEqual(notifications.map(value => [value.provider, value.fallback]), [['claude', false], ['codex', true], ['groq', true]])
  assert.match(notifications[2].reason, /Codex/)
  assert.equal(contexts[0].groqApiKey, undefined)
  assert.equal(contexts[1].groqApiKey, undefined)
  assert.equal(contexts[2].groqApiKey, options.groqApiKey)
  assert.equal(contexts[2].history, options.history)
  assert.equal(contexts[2].cfg.persona, options.cfg.persona)
  assert.equal(options.cfg.chatProvider, 'claude')
})

test('missing Groq key never blocks successful Claude or Codex requests', async () => {
  for (const provider of ['claude', 'codex']) {
    let requests = 0
    const deps = isolated({ claude: () => success('hello'), codex: () => success('hello'), groq: () => { requests++; throw new Error('must not invoke Groq') } })
    const task = chat.ask(opts({ cfg: { ...cfg, chatProvider: provider, groqFallbackEnabled: true }, groqApiKey: '' }), deps)
    assert.deepEqual(await task.done, { text: 'hello', provider })
    assert.equal(requests, 0)
  }
})

test('primary Codex falls directly to Groq after infrastructure failure', async () => {
  const order = []
  const deps = isolated({ claude: () => { order.push('claude'); return success('wrong') }, codex: () => { order.push('codex'); return failure(cliError('CLI_TIMEOUT', 'Codex timeout')) }, groq: () => { order.push('groq'); return success('available') } })
  assert.equal((await chat.ask(opts({ cfg: { ...cfg, chatProvider: 'codex', groqFallbackEnabled: true } }), deps).done).provider, 'groq')
  assert.deepEqual(order, ['codex', 'groq'])
})

test('known unavailable Claude and Codex are skipped until their own cooldowns expire', async () => {
  let now = 2_000_000_000_000
  let first = 0, second = 0, third = 0
  const deps = { ...isolated({
    claude: () => { first++; return failure(cliError('RATE_LIMIT', 'quota', { resetAt: now + 120_000 })) },
    codex: () => { second++; return second === 1 ? failure(cliError('NO_CODEX', 'missing')) : success('Codex recovered') },
    groq: () => { third++; return success('Groq') },
  }), now: () => now }
  const options = opts({ cfg: { ...cfg, groqFallbackEnabled: true } })
  assert.equal((await chat.ask(options, deps).done).provider, 'groq')
  now += 40_000
  assert.equal((await chat.ask(options, deps).done).provider, 'groq')
  assert.deepEqual([first, second, third], [1, 1, 2])
  now += 5000
  assert.equal((await chat.ask(options, deps).done).provider, 'codex')
  assert.deepEqual([first, second, third], [1, 2, 2])
})

test('all-provider failures name every cause while semantic Codex refusal stops before Groq', async () => {
  const options = opts({ cfg: { ...cfg, groqFallbackEnabled: true }, groqApiKey: '' })
  const deps = isolated({ claude: () => failure(cliError('NO_CLAUDE', 'Claude unavailable')), codex: () => failure(cliError('NO_CODEX', 'Codex unavailable')) })
  await assert.rejects(chat.ask(options, deps).done, err => {
    assert.equal(err.code, 'FALLBACK_FAILED')
    assert.match(err.message, /Claude Code: Claude unavailable/)
    assert.match(err.message, /Codex: Codex unavailable/)
    assert.match(err.message, /Groq: Groq API 키가 없어요/)
    assert.equal(err.providerErrors.length, 3)
    return true
  })
  let third = 0
  const refusal = chat.ask(options, isolated({ claude: () => failure(cliError('NO_CLAUDE', 'missing')), codex: () => failure(cliError('REQUEST_REFUSED', 'I cannot help with that.')), groq: () => { third++; return success('wrong') } }))
  await assert.rejects(refusal.done, err => err.code === 'FALLBACK_FAILED' && err.fallbackError.code === 'REQUEST_REFUSED')
  assert.equal(third, 0)
})

test('each failed partial answer is cleared before the next provider starts', async () => {
  const first = deferred(), second = deferred()
  let a, b
  const deltas = []
  const deps = isolated({
    claude: value => { a = value; return first },
    codex: value => { b = value; return second },
    groq: value => { a.onDelta('late', 'bad Claude'); b.onDelta('late', 'bad Codex'); value.onDelta('Groq', 'Groq'); return success('Groq') },
  })
  const task = chat.ask(opts({ cfg: { ...cfg, groqFallbackEnabled: true }, onDelta: (...value) => deltas.push(value) }), deps)
  a.onDelta('Claude partial', 'Claude partial')
  first.reject(cliError('ECONNRESET', 'lost'))
  await tick()
  b.onDelta('Codex partial', 'Codex partial')
  second.reject(cliError('ECONNRESET', 'lost again'))
  assert.equal((await task.done).provider, 'groq')
  assert.deepEqual(deltas, [['Claude partial', 'Claude partial'], ['', ''], ['Codex partial', 'Codex partial'], ['', ''], ['Groq', 'Groq']])
})

test('cancel in the Codex -> Groq transition gap prevents an HTTP request', async () => {
  const second = deferred()
  let resets = 0, third = 0, task
  const deps = isolated({ claude: () => failure(cliError('NO_CLAUDE', 'missing')), codex: () => second, groq: () => { third++; return success('wrong') } })
  task = chat.ask(opts({ cfg: { ...cfg, groqFallbackEnabled: true }, onDelta: (_part, full) => { if (full === '' && ++resets === 2) task.cancel() } }), deps)
  await tick()
  second.reject(cliError('CLI_TIMEOUT', 'timeout'))
  await assert.rejects(task.done, { code: 'CANCELLED' })
  await tick()
  assert.equal(third, 0)
})
