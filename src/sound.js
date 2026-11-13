// 효과음. 앱에 들어 있는 녹음 파일과 사용자가 고른 파일을 Web Audio로 한 번만 풀어 두고 재생한다.
// 같은 소리를 빠르게 여러 번 내면 앞의 소리를 끊지 않고 겹쳐서 낸다(쓰다듬기 연타, 글자마다 말소리).
//   쓰다듬을 때: squee(꺅, 기본) | custom | none
//   말할 때    : blip(기본 말소리)  | custom | none
//   채팅       : chatOpen, chatClose, chatEnter, chatResult, chatHappy (chatSound 스위치)
;(function (root) {
  const BUILTIN = {
    squee: 'squee.mp3',
    blip: 'talk.mp3',
    chatOpen: 'chat-open.mp3',
    chatClose: 'chat-close.mp3',
    chatEnter: 'chat-enter.mp3',
    chatResult: 'chat-result.mp3',
    chatHappy: 'chat-happy.wav',
  }
  const CHAT = new Set(['chatOpen', 'chatClose', 'chatEnter', 'chatResult', 'chatHappy'])
  const MAX_VOICES = { petting: 10, talking: 8, chat: 3 } // 한꺼번에 겹치는 수. 넘으면 가장 오래된 소리를 끈다.
  const SILENCE = 0.003 // 이보다 작은 소리는 들리지 않는 것으로 본다(끝의 무음은 재생하지 않는다)

  /** 소리가 실제로 끝나는 시각(초). 녹음 끝에 붙은 긴 무음을 겹침 수에서 빼려고 쓴다. */
  function audibleEnd(buffer) {
    let last = 0
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c)
      for (let i = data.length - 1; i > last; i--) {
        if (Math.abs(data[i]) > SILENCE) { last = i; break }
      }
    }
    return Math.min(buffer.duration, (last + 1) / buffer.sampleRate + 0.03)
  }

  function create({
    AudioContext = root.AudioContext || root.webkitAudioContext,
    load = name => (name.startsWith('custom:') ? root.pet?.readSound(name.slice(7)) : root.pet?.builtinSound(name)),
    onError = error => root.pet?.soundError?.(error),
  } = {}) {
    let context = null
    let cfg = {}
    let visible = true
    let generation = 0
    const buffers = new Map() // 소리 이름(또는 custom:파일id) → Promise<{ buffer, end }>
    const playing = { petting: [], talking: [], chat: [] }
    const reported = new Set()

    const enabled = () => visible && !!cfg.soundEnabled && Number(cfg.soundVolume) > 0
    // 소리가 다 끝나고 이만큼 조용하면 AudioContext를 잠재운다. 깨어 있는 AudioContext는 소리가 없어도
    // 오디오 장치와 오디오 스레드를 계속 붙잡고 있어 배터리를 쓴다. 다음 소리 때 자동으로 깨어난다.
    const IDLE_SUSPEND_MS = 4000
    let idleTimer = null
    const quiet = () => Object.values(playing).every(list => list.length === 0)
    function scheduleSuspend() {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimer = null
        if (quiet() && context?.state === 'running') context.suspend().catch(() => {})
      }, IDLE_SUSPEND_MS)
    }
    const volume = () => Math.min(100, Math.max(0, Number(cfg.soundVolume) || 0)) / 100

    function ensureContext() {
      if (!AudioContext) throw new Error('이 환경에서는 소리를 낼 수 없어요.')
      if (!context || context.state === 'closed') {
        try { context = new AudioContext() } catch { throw new Error('오디오 장치를 열지 못했어요. 소리 출력 장치를 확인해 주세요.') }
      }
      return context
    }

    /** 이 종류(쓰다듬기·말하기)에서 지금 낼 소리. null이면 소리 없음. */
    function pick(kind) {
      const choice = cfg[`${kind}Sound`]
      if (choice === 'none') return null
      if (choice === 'custom') {
        const id = cfg[`${kind}SoundFile`]?.id
        return id ? { key: `custom:${id}`, request: `custom:${kind}`, kind } : null
      }
      return { key: kind === 'petting' ? 'squee' : 'blip', request: kind === 'petting' ? 'squee' : 'blip', kind }
    }

    function decode({ key, request, kind }) {
      let entry = buffers.get(key)
      if (entry) return entry
      const audio = ensureContext()
      entry = Promise.resolve()
        .then(() => load(request))
        .then(async result => {
          // 사용자 파일은 고른 파일이 그 사이에 바뀌지 않았는지 확인한다.
          const bytes = result?.bytes ?? result
          if (key.startsWith('custom:') && result?.id && `custom:${result.id}` !== key) throw new Error('효과음 선택이 바뀌었어요. 다시 들어 봐 주세요.')
          const data = bytes instanceof ArrayBuffer ? bytes.slice(0)
            : ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            : Array.isArray(bytes) ? Uint8Array.from(bytes).buffer
            : null
          if (!data || !data.byteLength) throw new Error('효과음 파일을 읽지 못했어요.')
          let buffer
          try { buffer = await audio.decodeAudioData(data) } catch {
            throw new Error('이 오디오 파일은 재생할 수 없어요. WAV나 MP3 파일로 다시 골라 주세요.')
          }
          if (!buffer?.duration) throw new Error('소리가 없는 파일이에요.')
          return { buffer, end: audibleEnd(buffer) }
        })
      entry.catch(error => {
        buffers.delete(key)
        const message = error?.message || '효과음을 재생하지 못했어요.'
        if (kind && key.startsWith('custom:') && !reported.has(key + message)) {
          reported.add(key + message)
          try { onError({ kind, message }) } catch { /* 알리기에 실패해도 반응은 계속된다 */ }
        }
      })
      buffers.set(key, entry)
      return entry
    }

    async function start(target, group, { force = false } = {}) {
      if (!target || (!force && !enabled())) return
      const token = generation
      let sound
      try {
        sound = await decode(target)
        const audio = ensureContext()
        if (audio.state === 'suspended') await audio.resume()
      } catch { return }
      if (token !== generation || (!force && !enabled())) return
      const audio = context
      clearTimeout(idleTimer)
      const source = audio.createBufferSource()
      const gain = audio.createGain()
      source.buffer = sound.buffer
      gain.gain.value = volume()
      source.connect(gain)
      gain.connect(audio.destination)
      const list = playing[group]
      const voice = { source, gain }
      list.push(voice)
      // 겹치는 소리가 너무 많으면 가장 먼저 시작한 소리부터 끈다.
      while (list.length > MAX_VOICES[group]) {
        const old = list.shift()
        try { old.source.stop() } catch { /* 이미 끝남 */ }
      }
      source.onended = () => {
        const at = list.indexOf(voice)
        if (at >= 0) list.splice(at, 1)
        source.disconnect()
        gain.disconnect()
        if (quiet()) scheduleSuspend()
      }
      source.start(audio.currentTime, 0, sound.end)
    }

    function stopGroup(group) {
      for (const { source } of playing[group].splice(0)) {
        try { source.stop() } catch { /* 이미 끝남 */ }
      }
    }

    function stop() {
      generation++
      for (const group of Object.keys(playing)) stopGroup(group)
    }

    return {
      configure(next) {
        const before = cfg
        cfg = next || {}
        if (!enabled()) stop()
        // 고른 파일이 바뀌면 예전 파일은 메모리에서 뺀다.
        for (const kind of ['petting', 'talking']) {
          const old = before[`${kind}SoundFile`]?.id
          if (old && old !== cfg[`${kind}SoundFile`]?.id) buffers.delete(`custom:${old}`)
        }
        if (context) for (const list of Object.values(playing)) for (const { gain } of list) gain.gain.value = volume()
      },
      setVisible(next) {
        visible = !!next
        if (!visible) {
          stop()
          if (context?.state === 'running') context.suspend().catch(() => {})
        }
      },
      /** 첫 클릭 때 불러 둔다: 브라우저는 사용자가 누르기 전에는 소리를 내지 못하게 한다. */
      unlock() {
        if (!enabled() || !AudioContext) return
        try {
          ensureContext()
          if (context.state === 'suspended') context.resume().catch(() => {})
          for (const kind of ['petting', 'talking']) { const target = pick(kind); if (target) decode(target).catch(() => {}) }
          scheduleSuspend() // 눌러서 깨웠지만 소리가 안 나면 다시 잠재운다
        } catch { /* 오디오 장치가 없어도 앱은 돈다 */ }
      },
      pat() { return start(pick('petting'), 'petting') },
      talk() { return start(pick('talking'), 'talking') },
      play(name) {
        if (!CHAT.has(name) || cfg.chatSound === false) return Promise.resolve()
        return start({ key: name, request: name }, 'chat')
      },
      /** 설정 창의 듣기: 스위치와 상관없이 지금 고른 소리를 지금 볼륨으로 한 번. */
      preview(what) {
        if (what === 'petting' || what === 'talking') return start(pick(what), what, { force: true })
        if (CHAT.has(what)) return start({ key: what, request: what }, 'chat', { force: true })
        return Promise.resolve()
      },
      /** 고른 파일을 미리 풀어 본다. 재생할 수 없는 파일이면 오류를 낸다. */
      async prepare(kind) {
        const target = pick(kind)
        if (target) await decode(target)
      },
      stop,
      stopTalk: () => stopGroup('talking'),
      dispose() {
        clearTimeout(idleTimer)
        stop()
        buffers.clear()
        context?.close().catch(() => {})
        context = null
      },
      voices: () => ({ petting: playing.petting.length, talking: playing.talking.length, chat: playing.chat.length }),
    }
  }

  const api = { create, BUILTIN, audibleEnd }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.ClauSound = api
})(typeof window === 'undefined' ? globalThis : window)
