const { test } = require('node:test')
const assert = require('node:assert/strict')
const models = require('../src/models')

const codexCatalog = {
  models: [
    { slug: 'gpt-b', display_name: 'GPT B', description: 'second', visibility: 'list', priority: 2 },
    { slug: 'hidden-review', display_name: 'Review', visibility: 'hide', priority: 0 },
    { slug: 'gpt-a', display_name: 'GPT A', description: 'first', visibility: 'list', priority: 1 },
  ],
}

test('Codex list keeps only pickable models in the CLI order', () => {
  assert.deepEqual(models.codexList(codexCatalog).map(m => m.id), ['gpt-a', 'gpt-b'])
  assert.deepEqual(models.codexList(codexCatalog)[0], { id: 'gpt-a', label: 'GPT A', note: 'first' })
  assert.deepEqual(models.codexList(null), [])
})

test('Codex models come from the login cache first, then from the CLI', async () => {
  const cached = await models.codex({ home: '/h', env: {}, readFile: async file => { assert.equal(file, '/h/.codex/models_cache.json'); return JSON.stringify(codexCatalog) } })
  assert.equal(cached.source, 'account')
  assert.equal(cached.models.length, 2)
  const asked = await models.codex({
    bin: '/usr/bin/codex', home: '/h', env: {},
    readFile: async () => { throw new Error('missing') },
    run: (cmd, args, _opts, done) => { assert.deepEqual(args.slice(-2), ['debug', 'models']); done(null, JSON.stringify(codexCatalog)) },
  })
  assert.equal(asked.source, 'cli')
  const none = await models.codex({ home: '/h', env: {}, readFile: async () => { throw new Error('missing') } })
  assert.equal(none.models.length, 0)
  assert.match(none.error, /codex/)
})

test('Groq list drops speech, guard and embedding models and keeps chat models', () => {
  const list = models.groqList({ data: [
    { id: 'whisper-large-v3', owned_by: 'OpenAI' },
    { id: 'meta-llama/llama-guard-4-12b', owned_by: 'Meta' },
    { id: 'openai/gpt-oss-20b', owned_by: 'OpenAI', context_window: 131072 },
    { id: 'llama-3.1-8b-instant', owned_by: 'Meta', active: true },
    { id: 'old-model', active: false },
  ] })
  assert.deepEqual(list.map(m => m.id), ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'])
  assert.deepEqual(list[1], { id: 'openai/gpt-oss-20b', label: 'gpt-oss-20b', note: 'OpenAI · 131k' })
})

test('Groq models use the saved key, never put it in the URL, and fall back to known models', async () => {
  const key = 'gsk_fake_for_model_tests_only'
  let seen
  const ok = await models.groq({ key, fetch: async (url, options) => {
    seen = { url, options }
    return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b', owned_by: 'OpenAI' }] }), { status: 200 })
  } })
  assert.equal(ok.source, 'account')
  assert.equal(seen.url, models.GROQ_MODELS_URL)
  assert.ok(!seen.url.includes(key))
  assert.equal(seen.options.headers.Authorization, `Bearer ${key}`)
  const bad = await models.groq({ key, fetch: async () => new Response('{}', { status: 401 }) })
  assert.equal(bad.source, 'builtin')
  assert.match(bad.error, /키/)
  const offline = await models.groq({ key, fetch: async () => { throw new Error('offline') } })
  assert.deepEqual(offline.models, models.GROQ_BUILTIN)
  const noKey = await models.groq({ fetch: () => assert.fail('no request without a key') })
  assert.equal(noKey.source, 'builtin')
})
