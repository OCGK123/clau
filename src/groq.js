// Optional final fallback. The main process supplies the decrypted key only for
// this request; it is never part of settings, prompts, URLs or emitted events.
const { RULE } = require('./questions')
const { NO_EMOJI_RULE } = require('./clean')
const { cliError, rejected } = require('./cli')

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-oss-120b'
const MAX_RESPONSE_BYTES = 1_048_576
const MAX_EVENT_CHARS = 262_144
const MAX_ANSWER_CHARS = 32_768

function messagesFor({ question, history = [], cfg }) {
  const system = [cfg.persona, cfg.noEmoji ? NO_EMOJI_RULE : '', cfg.questionSignals ? RULE : ''].filter(Boolean).join(' ')
  return [
    { role: 'system', content: system },
    ...history.flatMap(turn => [{ role: 'user', content: String(turn.q) }, { role: 'assistant', content: String(turn.a) }]),
    { role: 'user', content: question },
  ]
}

function ask(options, deps = {}) {
  const key = typeof options.groqApiKey === 'string' ? options.groqApiKey.trim() : ''
  if (!key) return rejected(cliError('NO_GROQ_KEY', 'Groq API 키가 없어요. 설정 → 대화에서 키를 저장해 주세요.'))
  const fetcher = deps.fetch || globalThis.fetch
  if (typeof fetcher !== 'function') return rejected(cliError('NO_GROQ_FETCH', '이 실행 환경에서 Groq에 연결할 수 없어요. 클로를 최신 버전으로 설치해 주세요.'))
  const redact = value => String(value || '').split(key).join('[숨김]').replace(/gsk_[A-Za-z0-9_-]+/g, '[숨김]')
  const error = (code, message, details) => cliError(code, redact(message), details)
  const controller = new AbortController()
  let reader = null
  let settled = false
  let timer
  let resolveDone, rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const settle = (err, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (err) rejectDone(err)
    else resolveDone(value)
  }
  const stop = () => {
    controller.abort()
    try { reader?.cancel().catch(() => {}) } catch { /* Already released. */ }
  }
  const model = typeof options.cfg.groqModel === 'string' && options.cfg.groqModel.trim() || DEFAULT_MODEL
  const body = {
    model, messages: messagesFor(options), stream: true,
    max_completion_tokens: 1024, tool_choice: 'none',
    ...(model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low', include_reasoning: false } : {}),
  }
  timer = setTimeout(() => {
    settle(error('GROQ_TIMEOUT', 'Groq의 응답 시간이 초과됐어요. 연결 상태를 확인하고 다시 물어봐 주세요.'))
    stop()
  }, deps.timeoutMs ?? 90_000)
  timer.unref?.()

  async function run() {
    try {
      const response = await fetcher(ENDPOINT, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      })
      if (settled) { response.body?.cancel().catch(() => {}); return }
      if (!response.body || typeof response.body.getReader !== 'function') throw error('GROQ_PROTOCOL', 'Groq 응답 스트림을 열지 못했어요.')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let total = 0
      let text = ''
      let buffer = ''
      let completed = false
      let finished = false
      const parse = event => {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data.trim()) return
        if (data.trim() === '[DONE]') { completed = true; return }
        let msg
        try { msg = JSON.parse(data) } catch { throw error('GROQ_PROTOCOL', 'Groq 응답 형식을 읽지 못했어요. 다시 물어봐 주세요.') }
        if (msg.error) throw error('GROQ_API_ERROR', msg.error.message || 'Groq에서 응답을 완료하지 못했어요.')
        const choice = msg.choices?.[0]
        const delta = choice?.delta?.content ?? choice?.delta?.refusal
        if (typeof delta === 'string' && delta) {
          text += delta
          if (text.length > MAX_ANSWER_CHARS) throw error('GROQ_OUTPUT_LIMIT', 'Groq의 답변이 너무 길어 중지했어요.')
          if (!settled) options.onDelta?.(delta, text)
        }
        if (choice?.finish_reason) finished = true
      }
      // HTTP error bodies are bounded and sanitized before becoming UI errors.
      if (!response.ok) {
        let detail = ''
        while (detail.length < 16_384) {
          const next = await reader.read()
          if (next.done || settled) break
          detail = (detail + decoder.decode(next.value, { stream: true })).slice(0, 16_384)
        }
        stop()
        let message
        try { message = JSON.parse(detail).error?.message } catch { /* Generic status below. */ }
        const status = response.status
        const hint = status === 401 || status === 403 ? 'Groq API 키와 모델 접근 권한을 확인해 주세요.' : status === 429 ? 'Groq 사용 한도에 도달했어요. 잠시 뒤 다시 물어봐 주세요.' : status >= 500 ? 'Groq가 일시적으로 응답하지 않아요.' : 'Groq 모델과 설정을 확인해 주세요.'
        throw error(status === 429 ? 'GROQ_RATE_LIMIT' : status === 401 || status === 403 ? 'GROQ_AUTH' : 'GROQ_HTTP_ERROR', `${hint}${message ? ` ${String(message).slice(0, 1000)}` : ''}`, { status })
      }
      while (!settled && !completed) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > MAX_RESPONSE_BYTES) throw error('GROQ_OUTPUT_LIMIT', 'Groq 응답이 너무 커서 중지했어요.')
        buffer += decoder.decode(next.value, { stream: true })
        if (buffer.length > MAX_EVENT_CHARS) throw error('GROQ_OUTPUT_LIMIT', 'Groq 응답이 너무 커서 중지했어요.')
        let boundary
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          parse(event)
          if (completed || settled) break
        }
      }
      if (settled) return
      buffer += decoder.decode()
      if (!completed && buffer.trim()) parse(buffer)
      if (!completed && !finished) throw error('GROQ_INCOMPLETE', 'Groq 연결이 답변 도중 끊겼어요. 다시 물어봐 주세요.')
      if (!text.trim()) throw error('GROQ_EMPTY', 'Groq가 답 없이 끝났어요. 다시 물어봐 주세요.')
      settle(null, { text: text.trim() })
    } catch (err) {
      if (!settled) settle(error(err?.code?.startsWith?.('GROQ_') ? err.code : 'GROQ_CONNECTION', err?.message || 'Groq에 연결할 수 없어요.', err?.status ? { status: err.status } : undefined))
    } finally {
      stop()
      try { reader?.releaseLock() } catch { /* Reader is already released. */ }
    }
  }
  run()
  return {
    done,
    cancel() {
      if (settled) return
      settle(Object.assign(error('CANCELLED', '대화를 중지했어요.'), { name: 'AbortError' }))
      stop()
    },
  }
}

module.exports = { ask, messagesFor, ENDPOINT, DEFAULT_MODEL }
