// 고를 수 있는 모델 목록. 손으로 적어 두지 않고 쓰는 쪽에서 받아 온다.
//   Codex: 로그인한 CLI가 받아 둔 목록(~/.codex/models_cache.json), 없으면 `codex debug models`
//   Groq : 저장한 키로 계정의 모델 목록. 키가 없거나 연결이 안 되면 잘 알려진 몇 개만.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { commandFor } = require('./cli')

const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'
const GROQ_BUILTIN = [
  { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', note: 'OpenAI' },
  { id: 'openai/gpt-oss-20b', label: 'gpt-oss-20b', note: 'OpenAI · 빠름' },
  { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile', note: 'Meta' },
  { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant', note: 'Meta · 가장 빠름' },
]
// 대화용이 아닌 것: 받아쓰기, 음성, 검열용 분류기, 임베딩, 도구를 스스로 쓰는 묶음.
const NOT_CHAT = /whisper|tts|orpheus|playai|guard|embed|compound/i
const TIMEOUT_MS = 8000
const MAX_MODELS = 200

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '')

/** Codex가 주는 목록에서 고를 수 있는 것만, CLI가 보여 주는 순서대로. */
function codexList(raw) {
  const list = Array.isArray(raw?.models) ? raw.models : []
  return list
    .filter(m => m && text(m.slug, 200) && m.visibility === 'list')
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .slice(0, MAX_MODELS)
    .map(m => ({ id: text(m.slug, 200), label: text(m.display_name, 80) || text(m.slug, 200), note: text(m.description, 160) }))
}

function groqList(raw) {
  const list = Array.isArray(raw?.data) ? raw.data : []
  const window = n => (Number.isFinite(n) && n >= 1000 ? `${Math.round(n / 1000)}k` : '')
  return list
    .filter(m => m && text(m.id, 200) && m.active !== false && !NOT_CHAT.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_MODELS)
    .map(m => {
      const id = text(m.id, 200)
      return { id, label: id.slice(id.lastIndexOf('/') + 1), note: [text(m.owned_by, 60), window(m.context_window)].filter(Boolean).join(' · ') }
    })
}

async function codex({ bin, home = os.homedir(), env = process.env, readFile = fs.promises.readFile, run = execFile } = {}) {
  const file = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'models_cache.json')
  try {
    const models = codexList(JSON.parse(await readFile(file, 'utf8')))
    if (models.length) return { models, source: 'account' }
  } catch {
    // 아직 한 번도 안 썼거나 다른 판의 파일: CLI에 직접 묻는다.
  }
  if (!bin) return { models: [], source: 'none', error: 'codex 명령을 찾지 못했어요.' }
  try {
    const command = commandFor(bin, 'codex')
    const out = await new Promise((resolve, reject) => {
      run(command.bin, [...command.prefix, 'debug', 'models'], { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...env, ...command.env } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)))
    })
    const models = codexList(JSON.parse(out))
    if (models.length) return { models, source: 'cli' }
    return { models: [], source: 'none', error: 'Codex가 모델 목록을 주지 않았어요.' }
  } catch {
    return { models: [], source: 'none', error: 'Codex에서 모델 목록을 받지 못했어요. codex login 으로 로그인해 주세요.' }
  }
}

async function groq({ key, fetch: fetcher = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!key) return { models: GROQ_BUILTIN, source: 'builtin' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal, redirect: 'error' })
    if (response.status === 401 || response.status === 403) return { models: GROQ_BUILTIN, source: 'builtin', error: 'Groq API 키가 맞지 않아요.' }
    if (!response.ok) throw new Error(String(response.status))
    const models = groqList(await response.json())
    if (models.length) return { models, source: 'account' }
    throw new Error('empty')
  } catch {
    return { models: GROQ_BUILTIN, source: 'builtin', error: 'Groq에서 모델 목록을 받지 못했어요.' }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { codex, groq, codexList, groqList, GROQ_BUILTIN, GROQ_MODELS_URL }
