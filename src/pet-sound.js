// Synthesized presets and user-selected local audio, decoded once per selection.
;(function (root) {
  function create({
    AudioContext = root.AudioContext || root.webkitAudioContext,
    now = () => performance.now(),
    loader = kind => root.pet?.readSound(kind),
    onError = error => root.pet?.soundError?.(error),
  } = {}) {
    let context = null
    let cfg = {}
    let lastTalk = -Infinity
    let lastPat = -Infinity
    let generation = 0
    let synthGeneration = 0
    let visible = true
    const voices = new Set()
    const synthVoices = new Set()
    const customVoices = new Map()
    const pendingVoices = new Map()
    const decoded = new Map()
    const reported = new Set()
    const enabled = () => visible && cfg.soundEnabled && Number(cfg.soundVolume) > 0
    const selection = kind => cfg[`${kind}SoundFile`]?.id || ''
    const fingerprint = value => ['petting', 'talking'].map(kind => `${value[`${kind}Sound`]}:${value[`${kind}SoundFile`]?.id || ''}`).join('|')
    const volume = () => Math.min(100, Math.max(0, Number(cfg.soundVolume))) / 100

    function ensureContext() {
      if (!AudioContext) throw new Error('이 환경에서 오디오를 재생할 수 없어요.')
      if (!context || context.state === 'closed') {
        try { context = new AudioContext() } catch { throw new Error('오디오 장치를 열지 못했어요. 소리 출력 장치를 확인해 주세요.') }
      }
      return context
    }

    function stop() {
      generation++
      synthGeneration++
      for (const voice of voices) {
        try { voice.stop() } catch { /* Already ended. */ }
      }
      voices.clear()
      synthVoices.clear()
      customVoices.clear()
      pendingVoices.clear()
    }

    function stopSynth() {
      synthGeneration++
      for (const voice of synthVoices) {
        try { voice.stop() } catch { /* Already ended. */ }
        voices.delete(voice)
      }
      synthVoices.clear()
    }

    function bytesForDecode(bytes) {
      if (bytes instanceof ArrayBuffer) return bytes.slice(0)
      if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      if (Array.isArray(bytes)) return Uint8Array.from(bytes).buffer
      if (bytes?.type === 'Buffer' && Array.isArray(bytes.data)) return Uint8Array.from(bytes.data).buffer
      throw new Error('효과음 파일을 읽지 못했어요. 설정에서 파일을 다시 선택해 주세요.')
    }

    function loadBuffer(kind, retry = false) {
      if (!['petting', 'talking'].includes(kind)) return Promise.reject(new Error('쓰다듬기 또는 말하기 효과음을 선택해 주세요.'))
      const id = selection(kind)
      if (!id) return Promise.reject(new Error('사용할 효과음 파일을 먼저 선택해 주세요.'))
      let entry = decoded.get(id)
      if (entry?.error && retry) { decoded.delete(id); entry = null }
      if (entry) return entry.promise
      const audioContext = ensureContext()
      entry = { error: null, promise: null }
      entry.promise = Promise.resolve().then(() => loader(kind)).then(async result => {
        if (!result || result.id !== id) throw new Error('효과음 선택이 바뀌었어요. 듣기를 다시 눌러 주세요.')
        const bytes = bytesForDecode(result.bytes)
        if (!bytes.byteLength) throw new Error('비어 있는 효과음 파일이에요. 파일을 다시 선택해 주세요.')
        let buffer
        try { buffer = await audioContext.decodeAudioData(bytes) } catch {
          throw new Error('이 오디오 파일을 재생할 수 없어요. 손상되지 않은 파일이나 WAV·MP3 형식으로 다시 선택해 주세요.')
        }
        if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('소리가 없는 파일이에요. 다른 오디오 파일을 선택해 주세요.')
        return buffer
      }).catch(error => {
        entry.error = error
        throw error
      })
      decoded.set(id, entry)
      return entry.promise
    }

    async function playCustom(kind) {
      if (!enabled() || customVoices.has(kind) || pendingVoices.has(kind)) return
      const id = selection(kind)
      const token = { id, generation }
      pendingVoices.set(kind, token)
      try {
        const buffer = await loadBuffer(kind)
        const audioContext = context
        if (!audioContext) return
        if (audioContext.state === 'suspended') await audioContext.resume()
        if (!enabled() || context !== audioContext || token.generation !== generation || selection(kind) !== id || customVoices.has(kind)) return
        const source = audioContext.createBufferSource()
        const gain = audioContext.createGain()
        source.buffer = buffer
        source.loop = false
        gain.gain.setValueAtTime(volume(), audioContext.currentTime)
        source.connect(gain)
        gain.connect(audioContext.destination)
        voices.add(source)
        customVoices.set(kind, { source, gain })
        source.onended = () => {
          voices.delete(source)
          if (customVoices.get(kind)?.source === source) customVoices.delete(kind)
          source.disconnect()
          gain.disconnect()
        }
        source.start(audioContext.currentTime) // Full one-shot; no arbitrary cutoff.
      } catch (error) {
        if (token.generation !== generation || selection(kind) !== id) return
        const message = error?.message || '효과음을 재생하지 못했어요. 설정에서 파일을 다시 선택해 주세요.'
        const key = `${kind}:${id}:${message}`
        if (!reported.has(key)) {
          reported.add(key)
          try { onError({ kind, message }) } catch { /* Reporting must not break pet interaction. */ }
        }
      } finally {
        if (pendingVoices.get(kind) === token) pendingVoices.delete(kind)
      }
    }

    function tone(frequency, duration, offset = 0, type = 'sine', loudness = 1) {
      if (!enabled() || !context || voices.size >= 8) return
      if (context.state === 'suspended') {
        // resume() is asynchronous even inside a click; retain that first pat.
        const pendingContext = context
        const pendingGeneration = generation
        const pendingSynthGeneration = synthGeneration
        context.resume().then(() => {
          if (generation === pendingGeneration && synthGeneration === pendingSynthGeneration && context === pendingContext && context.state === 'running') tone(frequency, duration, offset, type, loudness)
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
      envelope.gain.setValueAtTime(0.0001, start)
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume() * 0.09 * loudness), start + 0.006)
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
      oscillator.connect(envelope)
      envelope.connect(context.destination)
      voices.add(oscillator)
      synthVoices.add(oscillator)
      oscillator.onended = () => {
        voices.delete(oscillator)
        synthVoices.delete(oscillator)
        oscillator.disconnect()
        envelope.disconnect()
      }
      oscillator.start(start)
      oscillator.stop(start + duration + 0.01)
    }

    return {
      configure(next) {
        const changed = fingerprint(cfg) !== fingerprint(next || {})
        cfg = next || {}
        if (changed || !enabled()) stop()
        if (changed) {
          reported.clear()
          lastPat = lastTalk = -Infinity
          const selected = new Set(['petting', 'talking'].map(selection).filter(Boolean))
          for (const id of decoded.keys()) if (!selected.has(id)) decoded.delete(id)
        }
        if (enabled() && context) {
          for (const { gain } of customVoices.values()) gain.gain.setValueAtTime(volume(), context.currentTime)
        }
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
          ensureContext()
          if (context.state === 'suspended') context.resume().catch(() => {})
        } catch { /* Audio devices are optional; interaction must still work. */ }
      },
      pat(combo = 1) {
        if (!enabled() || now() - lastPat < 100 || cfg.pettingSound === 'none') return
        lastPat = now()
        if (cfg.pettingSound === 'custom') { void playCustom('petting'); return }
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
        if (cfg.talkingSound === 'custom') { void playCustom('talking'); return }
        if (cfg.talkingSound === 'type') tone(420, 0.024, 0, 'triangle', 0.22)
        else tone(360, 0.055, 0, 'sine', 0.35)
      },
      async prepare(kind) {
        if (!['petting', 'talking'].includes(kind)) throw new Error('쓰다듬기 또는 말하기 효과음을 선택해 주세요.')
        if (cfg[`${kind}Sound`] !== 'custom') return
        await loadBuffer(kind, true)
        // A successful explicit preview clears a previously reported failure.
        for (const key of reported) if (key.startsWith(`${kind}:${selection(kind)}:`)) reported.delete(key)
      },
      stop,
      stopSynth,
      dispose() {
        stop()
        decoded.clear()
        reported.clear()
        context?.close().catch(() => {})
        context = null
      },
    }
  }

  const api = { create }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PetSound = api
})(typeof window === 'undefined' ? globalThis : window)
