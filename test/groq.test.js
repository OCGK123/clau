const { test } = require('node:test')
const assert = require('node:assert/strict')
const groq = require('../src/groq')

const key = 'gsk_fake_for_unit_tests_only'
const cfg = { persona: '너는 클로야. 짧게 말해.', noEmoji: true }
const opts = extra => ({ question: '안녕?', history: [{ q: '이름?', a: '클로야.' }], cfg, groqApiKey: key, ...extra })
const event = value => `data: ${JSON.stringify(value)}\n\n`
const delta = content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
const finished = { choices: [{ delta: {}, finish_reason: 'stop' }] }
function response(text, chunks = null) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    if (chunks) for (let at = 0; at < bytes.length; at += chunks) controller.enqueue(bytes.slice(at, at + chunks))
    else controller.enqueue(bytes)
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}

test('Groq posts only to the official endpoint with context and streams the answer', async () => {
  const calls = [], deltas = []
  const task = groq.ask(opts({ onDelta: (...value) => deltas.push(value) }), { fetch: async (...args) => {
    calls.push(args)
    return response(event(delta('안녕')) + event(delta('!')) + event(finished) + 'data: [DONE]\n\n', 7)
  } })
  assert.deepEqual(await task.done, { text: '안녕!' })
  assert.deepEqual(deltas, [['안녕', '안녕'], ['!', '안녕!']])
  assert.equal(calls.length, 1)
  const [url, options] = calls[0]
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers.Authorization, `Bearer ${key}`)
  assert.equal(options.redirect, 'error', 'do not forward a key to a redirect target')
  const body = JSON.parse(options.body)
  assert.equal(body.model, 'openai/gpt-oss-120b')
  assert.equal(body.stream, true)
  assert.equal(body.tool_choice, 'none')
  assert.equal(body.tools, undefined)
  assert.equal(body.include_reasoning, false)
  assert.equal(body.reasoning_format, undefined)
  assert.equal(body.reasoning_effort, 'low')
  assert.match(body.messages[0].content, /너는 클로야/)
  assert.match(body.messages[0].content, /이모지와 이모티콘/)
  assert.deepEqual(body.messages.slice(1), [{ role: 'user', content: '이름?' }, { role: 'assistant', content: '클로야.' }, { role: 'user', content: '안녕?' }])
  assert.equal(options.body.includes(key), false)
})

test('SSE supports split UTF-8, CRLF, comments and finish_reason without final DONE', async () => {
  const data = ': keepalive\r\n\r\n' + (event(delta('반가워요!')) + event(finished)).replaceAll('\n', '\r\n')
  const task = groq.ask(opts(), { fetch: async () => response(data, 1) })
  assert.equal((await task.done).text, '반가워요!')
})

test('custom models preserve the ID without unsupported reasoning options', async () => {
  let body
  const task = groq.ask(opts({ cfg: { ...cfg, groqModel: 'qwen/qwen3.8-27b', noEmoji: false } }), { fetch: async (_url, options) => {
    body = JSON.parse(options.body)
    return response(event(delta('hi')) + 'data: [DONE]\n\n')
  } })
  await task.done
  assert.equal(body.model, 'qwen/qwen3.8-27b')
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.reasoning_format, undefined)
  assert.equal(body.messages[0].content, cfg.persona)
})

test('missing API key fails only when Groq is actually invoked and sends no request', async () => {
  let called = false
  const task = groq.ask(opts({ groqApiKey: '' }), { fetch: () => { called = true } })
  await assert.rejects(task.done, { code: 'NO_GROQ_KEY' })
  assert.equal(called, false)
})

test('HTTP errors are actionable, bounded and redact API keys', async () => {
  for (const [status, code] of [[401, 'GROQ_AUTH'], [403, 'GROQ_AUTH'], [429, 'GROQ_RATE_LIMIT'], [503, 'GROQ_HTTP_ERROR']]) {
    const task = groq.ask(opts(), { fetch: async () => new Response(JSON.stringify({ error: { message: `request used ${key}; another gsk_another_fake_secret` } }), { status }) })
    await assert.rejects(task.done, err => {
      assert.equal(err.code, code)
      assert.equal(err.status, status)
      assert.equal(err.message.includes(key), false)
      assert.equal(err.stack.includes('gsk_another_fake_secret'), false)
      assert.match(err.message, /숨김/)
      return true
    })
  }
})

test('network exceptions and stream errors do not expose credentials', async () => {
  const task = groq.ask(opts(), { fetch: async () => { throw new Error(`network failed with ${key}`) } })
  await assert.rejects(task.done, err => err.code === 'GROQ_CONNECTION' && !err.message.includes(key))
  const stream = groq.ask(opts(), { fetch: async () => response(event({ error: { message: `invalid token ${key}` } })) })
  await assert.rejects(stream.done, err => err.code === 'GROQ_API_ERROR' && !err.message.includes(key))
})

test('malformed, empty and incomplete streams never count partial output as success', async () => {
  for (const [data, code] of [
    ['data: {broken}\n\n', 'GROQ_PROTOCOL'],
    [event(finished) + 'data: [DONE]\n\n', 'GROQ_EMPTY'],
    [event(delta('partial')), 'GROQ_INCOMPLETE'],
  ]) {
    await assert.rejects(groq.ask(opts(), { fetch: async () => response(data) }).done, { code })
  }
})

test('reasoning and tool-call fragments are ignored rather than exposed or executed', async () => {
  const data = event({ choices: [{ delta: { reasoning: 'private chain', tool_calls: [{ function: { name: 'execute', arguments: '{}' } }] } }] }) + event(delta('Public answer')) + event(finished) + 'data: [DONE]\n\n'
  let calls = 0
  const task = groq.ask(opts(), { fetch: async () => { calls++; return response(data) } })
  assert.deepEqual(await task.done, { text: 'Public answer' })
  assert.equal(calls, 1)
})

test('oversized SSE events and answers are stopped', async () => {
  await assert.rejects(groq.ask(opts(), { fetch: async () => response('data: ' + 'x'.repeat(262_145)) }).done, { code: 'GROQ_OUTPUT_LIMIT' })
  await assert.rejects(groq.ask(opts(), { fetch: async () => response(event(delta('x'.repeat(32_769)))) }).done, { code: 'GROQ_OUTPUT_LIMIT' })
})

test('cancel before headers rejects promptly and aborts the request', async () => {
  let signal, resolveFetch
  const task = groq.ask(opts(), { fetch: (_url, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve }) } })
  task.cancel()
  await assert.rejects(task.done, { code: 'CANCELLED', name: 'AbortError' })
  assert.equal(signal.aborted, true)
  resolveFetch(response(event(delta('late'))))
  await new Promise(resolve => setImmediate(resolve))
})

test('cancel midstream stops the reader and suppresses late deltas', async () => {
  let controller, cancelled = false
  const seen = []
  const stream = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled = true } })
  const task = groq.ask(opts({ onDelta: (...value) => seen.push(value) }), { fetch: async () => new Response(stream) })
  controller.enqueue(new TextEncoder().encode(event(delta('first'))))
  await new Promise(resolve => setImmediate(resolve))
  task.cancel()
  await assert.rejects(task.done, { code: 'CANCELLED' })
  assert.equal(cancelled, true)
  assert.deepEqual(seen, [['first', 'first']])
})

test('one total timeout aborts even a fetch implementation that never resolves', async () => {
  let signal
  const task = groq.ask(opts(), { timeoutMs: 5, fetch: (_url, options) => { signal = options.signal; return new Promise(() => {}) } })
  const keepAlive = setTimeout(() => {}, 100)
  try { await assert.rejects(task.done, { code: 'GROQ_TIMEOUT' }) } finally { clearTimeout(keepAlive) }
  assert.equal(signal.aborted, true)
})
