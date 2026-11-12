const claude = require('./claude')
const codex = require('./codex')
const groq = require('./groq')
const { rejected, cliError, infrastructureFailure, isCancellation, isRejectedRateLimit, resetTime } = require('./cli')

// Availability is a short-lived hint, never a saved provider preference.
const availability = new Map()
const COOLDOWN_MS = 45_000
const labels = { claude: 'Claude Code', codex: 'Codex', groq: 'Groq' }
const keyFor = (cfg, provider) => provider === 'codex' ? `codex:\n${cfg.codexPath || '<auto>'}\n${cfg.codexModel || '<default>'}` : `${cfg.claudePath || '<auto>'}\n${cfg.model || '<default>'}`
const abortError = () => Object.assign(cliError('CANCELLED', '대화를 중지했어요.'), { name: 'AbortError' })

function classify(provider, err, now) {
  if (isCancellation(err)) return null
  const failure = provider === 'codex' && err?.code === 'NO_CODEX'
    ? { kind: 'cli', reason: 'Codex 실행 파일을 사용할 수 없어요.', resetAt: null }
    : provider === 'codex' && /Codex가 답 없이 끝났어요/.test(err?.message || '')
      ? { kind: 'service', reason: 'Codex가 답변하지 못했어요.', resetAt: null }
      : infrastructureFailure(err, now)
  return failure ? { ...failure, reason: failure.reason.replaceAll('Claude Code', labels[provider]) } : null
}

function ask(options, deps = {}) {
  if (options.cfg.chatEnabled === false) return rejected(cliError('CHAT_DISABLED', '설정에서 눌러서 대화를 켜 주세요.'))
  const primary = options.cfg.chatProvider === 'codex' ? 'codex' : 'claude'
  const groqEnabled = options.cfg.groqFallbackEnabled === true
  // Enabling the final fallback keeps the requested Claude -> Codex -> Groq order.
  const chain = [primary]
  if (primary === 'claude' && (options.cfg.claudeFallbackToCodex === true || groqEnabled)) chain.push('codex')
  if (groqEnabled) chain.push('groq')
  const now = deps.now || Date.now
  const cache = deps.availability || availability
  const failures = []
  const { groqApiKey, ...publicOptions } = options
  let active = null
  let generation = 0
  let cancelled = false
  let settled = false
  let resolveDone, rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const finish = (err, value) => {
    if (settled) return
    settled = true
    active = null
    if (err) rejectDone(err)
    else resolveDone(value)
  }
  function combined(err) {
    if (failures.length < 2) return err
    const lines = failures.map(failure => `${labels[failure.provider]}: ${failure.error?.message || failure.error}`)
    const hint = failures.at(-1).provider === 'groq'
      ? '설정 → 대화에서 Groq API 키와 모델을, 실행에서 CLI 경로와 로그인 상태를 확인해 주세요.'
      : '설정 → 실행에서 Codex 실행 파일과 로그인 상태를 확인해 주세요.'
    return cliError('FALLBACK_FAILED', `${lines.join('\n')}\n${hint}`, {
      primaryError: failures[0].error, fallbackError: err,
      providerErrors: failures.map(value => ({ provider: value.provider, error: value.error })),
    })
  }
  function route(index, reason = null) {
    if (cancelled || settled) return
    // Skip a provider only while there is an enabled next provider to use.
    while (index < chain.length - 1) {
      const provider = chain[index]
      const key = keyFor(options.cfg, provider)
      const saved = cache.get(key)
      if (!saved || saved.until <= now()) { if (saved) cache.delete(key); break }
      failures.push({ provider, error: saved.error })
      reason = saved.reason
      index++
    }
    launch(index, reason)
  }
  function launch(index, reason) {
    if (cancelled || settled) return
    const provider = chain[index]
    const fallback = index > 0
    const token = ++generation
    const current = () => !cancelled && !settled && token === generation
    const callbacks = {
      ...publicOptions,
      ...(provider === 'groq' ? { groqApiKey } : {}),
      onDelta: (...args) => { if (current()) options.onDelta?.(...args) },
      onRateLimit: info => {
        if (!current()) return
        // A rejected primary request is being rerouted, so it must not put the
        // character to sleep or prevent the user's next request to a fallback.
        if (provider === 'claude' && index < chain.length - 1 && isRejectedRateLimit(info)) {
          throw cliError('RATE_LIMIT', 'Claude Code 사용 한도에 도달했어요.', { rateLimitInfo: info, resetAt: resetTime(info, now()) })
        }
        options.onRateLimit?.(info)
      },
    }
    const providerAsk = deps.providers?.[provider] || { claude, codex, groq }[provider].ask
    try { active = providerAsk(callbacks, deps) } catch (err) { active = rejected(err) }
    // The caller stores its job after ask() returns; defer initial routing so
    // the main process can safely identify this request before sending its UI.
    queueMicrotask(() => {
      if (current()) {
        try { options.onProvider?.({ provider, fallback, reason }) } catch (err) { const running = active; finish(err); running?.cancel() }
      }
    })
    Promise.resolve(active.done).then(result => {
      if (!current()) return
      if (provider !== 'groq') cache.delete(keyFor(options.cfg, provider))
      finish(null, { ...result, provider })
    }, err => {
      if (!current()) return
      const failure = index < chain.length - 1 ? classify(provider, err, now()) : null
      failures.push({ provider, error: err })
      if (failure) {
        const until = failure.resetAt || now() + COOLDOWN_MS
        cache.set(keyFor(options.cfg, provider), { until, error: err, reason: failure.reason })
        if (cache.size > 32) cache.delete(cache.keys().next().value)
        active = null
        // Discard incomplete text before each next provider, never mix replies.
        try { options.onDelta?.('', '') } catch (observerError) { finish(observerError); return }
        if (!current()) return // Cancellation is allowed inside the transition.
        route(index + 1, failure.reason)
      } else finish(isCancellation(err) ? err : combined(err))
    })
  }
  route(0)
  return {
    done,
    cancel() {
      if (settled || cancelled) return
      cancelled = true
      generation++
      const running = active
      finish(abortError())
      running?.cancel()
    },
  }
}

module.exports = { ask, findClaude: claude.findClaude, findCodex: codex.findCodex, clearAvailability: () => availability.clear() }
