// Tiny, locally synthesized interaction sounds: no downloads or microphone.
;(function (root) {
  function create({ AudioContext = root.AudioContext || root.webkitAudioContext, now = () => performance.now() } = {}) {
    let context = null
    let cfg = {}
    let lastTalk = -Infinity
    let lastPat = -Infinity
    let generation = 0
    let visible = true
    const voices = new Set()
    const enabled = () => visible && cfg.soundEnabled && Number(cfg.soundVolume) > 0

    function stop() {
      generation++
      for (const voice of voices) {
        try { voice.stop() } catch { /* Already ended. */ }
      }
      voices.clear()
    }

    function tone(frequency, duration, offset = 0, type = 'sine', loudness = 1) {
      if (!enabled() || !context || voices.size >= 8) return
      if (context.state === 'suspended') {
        // resume() is asynchronous even inside a click; retain that first pat.
        const pendingContext = context
        const pendingGeneration = generation
        context.resume().then(() => {
          if (generation === pendingGeneration && context === pendingContext && context.state === 'running') tone(frequency, duration, offset, type, loudness)
        }).catch(() => {})
        return
      }
      if (context.state !== 'running') return
      const start = context.currentTime + offset
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      oscillator.type = type
      oscillator.frequency.setValueAtTime(frequency, start)
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.82, start + duration)
      const volume = Math.min(100, Math.max(0, Number(cfg.soundVolume))) / 100
      envelope.gain.setValueAtTime(0.0001, start)
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.09 * loudness), start + 0.006)
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
      oscillator.connect(envelope)
      envelope.connect(context.destination)
      voices.add(oscillator)
      oscillator.onended = () => {
        voices.delete(oscillator)
        oscillator.disconnect()
        envelope.disconnect()
      }
      oscillator.start(start)
      oscillator.stop(start + duration + 0.01)
    }

    return {
      configure(next) {
        cfg = next || {}
        if (!enabled()) stop()
      },
      setVisible(next) {
        visible = !!next
        if (!visible) {
          stop()
          if (context?.state === 'running' && context.suspend) context.suspend().catch(() => {})
        }
      },
      unlock() {
        if (!enabled() || !AudioContext) return
        try {
          if (!context) context = new AudioContext()
          if (context.state === 'suspended') context.resume().catch(() => {})
        } catch { /* Audio devices are optional; interaction must still work. */ }
      },
      pat(combo = 1) {
        if (!enabled() || now() - lastPat < 100 || cfg.pettingSound === 'none') return
        lastPat = now()
        const pitch = 660 + Math.min(8, combo) * 24
        if (cfg.pettingSound === 'pop') tone(pitch * 0.6, 0.09, 0, 'sine', 0.8)
        else {
          tone(pitch, 0.13, 0, 'sine', 0.7)
          tone(pitch * 1.5, 0.16, 0.065, 'sine', 0.45)
        }
      },
      talk() {
        if (!enabled() || now() - lastTalk < 105 || cfg.talkingSound === 'none') return
        lastTalk = now()
        if (cfg.talkingSound === 'type') tone(420, 0.024, 0, 'triangle', 0.22)
        else tone(360, 0.055, 0, 'sine', 0.35)
      },
      stop,
      dispose() {
        stop()
        context?.close().catch(() => {})
        context = null
      },
    }
  }

  const api = { create }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PetSound = api
})(typeof window === 'undefined' ? globalThis : window)
