// 이미 로그인된 Claude Code(`claude -p`)로 대답한다.
const { NO_EMOJI_RULE } = require('./clean')
const { findExecutable, runJsonLines, rejected, cliError, isRejectedRateLimit, resetTime } = require('./cli')

const findClaude = (custom, options) => findExecutable('claude', custom, options)

/** 지난 대화를 붙여 한 번의 질문으로 만든다(세션을 디스크에 남기지 않는다). */
function buildPrompt(question, history = []) {
  if (!history.length) return question
  const past = history.map(t => `사용자: ${t.q}\n클로: ${t.a}`).join('\n')
  return `(지금까지의 대화)\n${past}\n\n(사용자가 방금 한 말)\n${question}`
}

function ask({ question, history, cfg, cwd, onDelta, onRateLimit }, deps = {}) {
  const bin = (deps.findClaude || findClaude)(cfg.claudePath)
  if (!bin) {
    const err = new Error('claude 명령을 찾지 못했어요. 설정에서 claude 실행 파일 경로를 지정해 주세요.')
    err.code = 'NO_CLAUDE'
    return rejected(err)
  }
  const args = [
    '-p', '--model', cfg.model,
    '--safe-mode', '--tools', '', '--no-session-persistence',
    '--system-prompt', cfg.noEmoji ? `${cfg.persona} ${NO_EMOJI_RULE}` : cfg.persona,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  ]
  let text = ''
  let finalText = null
  let failed = null
  let rateLimitInfo = null
  const resultError = msg => {
    const details = Array.isArray(msg.errors) ? msg.errors.filter(value => typeof value === 'string').join('\n') : ''
    const message = typeof msg.result === 'string' && msg.result || details || msg.message || msg.subtype || '요청이 실패했어요.'
    const code = typeof msg.error === 'string' ? msg.error : msg.error?.type || msg.error?.code || 'CLAUDE_REQUEST_FAILED'
    return cliError(String(code).toUpperCase(), String(message), { rateLimitInfo, resetAt: resetTime(rateLimitInfo), status: msg.error?.status ?? msg.status ?? msg.status_code })
  }
  return runJsonLines({
    bin, name: 'claude', args, cwd, prompt: buildPrompt(question, history),
    onMessage(msg) {
      if (msg.type === 'stream_event') {
        const ev = msg.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text
          onDelta?.(ev.delta.text, text)
        }
      } else if (msg.type === 'rate_limit_event') {
        rateLimitInfo = msg.rate_limit_info || {}
        if (isRejectedRateLimit(rateLimitInfo)) failed = cliError('RATE_LIMIT', 'Claude Code 사용 한도에 도달했어요.', { rateLimitInfo, resetAt: resetTime(rateLimitInfo) })
        onRateLimit?.(rateLimitInfo)
        if (failed) throw failed
      } else if (msg.type === 'assistant' && msg.error) {
        const message = (msg.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
        failed = resultError({ ...msg, result: message })
      } else if (msg.type === 'result') {
        if (msg.is_error) failed = failed || resultError(msg)
        else if (typeof msg.result === 'string') finalText = msg.result
      }
    },
    failure: () => failed,
    finish() {
      if (failed) throw failed
      const answer = (finalText ?? text).trim()
      if (!answer) throw cliError('CLI_EMPTY', 'claude가 답 없이 끝났어요. Claude Code 로그인 상태를 확인해 주세요.')
      return { text: answer }
    },
  }, deps)
}

module.exports = { ask, findClaude, buildPrompt }
