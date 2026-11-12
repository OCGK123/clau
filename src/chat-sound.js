// 녹음된 효과음(assets/sounds) 재생기. pet-sound.js의 합성음과 같은 스위치·볼륨을 따른다.
// - 효과음 켜기(soundEnabled) + 소리 크기(soundVolume)가 전체를 다스리고
// - 쓰다듬기 소리를 '꺅'(squee)으로 고르면 squee가, 채팅 효과음(chatSound)을 켜면 채팅 소리가 난다.
;(function (root) {
  const FILES = {
    squee: { file: 'squee.mp3', voices: 4 }, // 머리를 눌러 깜짝 놀랄 때(연타 때 겹쳐 나도록 4개)
    chatOpen: { file: 'chat-open.mp3', voices: 1 }, // 말풍선이 열릴 때
    chatClose: { file: 'chat-close.mp3', voices: 1 }, // 말풍선이 닫힐 때
    chatEnter: { file: 'chat-enter.mp3', voices: 1 }, // 질문을 보낼 때
    chatResult: { file: 'chat-result.mp3', voices: 1 }, // 대답 글자가 처음 나타날 때
    chatHappy: { file: 'chat-happy.wav', voices: 1 }, // 대답을 마치고 신났을 때
  }
  const CHAT = new Set(['chatOpen', 'chatClose', 'chatEnter', 'chatResult', 'chatHappy'])
  const BASE_GAIN = 0.9 // 녹음 파일이 합성음보다 커서 조금 줄인다

  function create({ Audio = root.Audio, base = '../assets/sounds/' } = {}) {
    let cfg = {}
    let visible = true
    const pools = new Map()

    /** 지금 설정에서 이 소리를 내도 되는가. */
    function allowed(name) {
      if (!visible || !cfg.soundEnabled || !(Number(cfg.soundVolume) > 0)) return false
      if (name === 'squee') return cfg.pettingSound === 'squee'
      if (CHAT.has(name)) return cfg.chatSound !== false
      return false
    }

    function pool(name) {
      if (pools.has(name)) return pools.get(name)
      const spec = FILES[name]
      if (!spec || !Audio) return null
      const list = Array.from({ length: spec.voices }, () => {
        const a = new Audio(base + spec.file)
        a.preload = 'auto'
        return a
      })
      const entry = { list, next: 0 }
      pools.set(name, entry)
      return entry
    }

    function play(name, { force = false } = {}) {
      if (!force && !allowed(name)) return
      const entry = pool(name)
      if (!entry) return
      const a = entry.list[entry.next]
      entry.next = (entry.next + 1) % entry.list.length
      try {
        a.volume = Math.min(1, Math.max(0, (Number(cfg.soundVolume) / 100) * BASE_GAIN))
        a.currentTime = 0
        const p = a.play()
        if (p && p.catch) p.catch(() => {}) // 소리를 못 내도 반응과 대화는 그대로 간다
      } catch {
        // 오디오 장치가 없어도 앱은 동작해야 한다.
      }
    }

    function stop() {
      for (const { list } of pools.values()) for (const a of list) {
        try { a.pause() } catch { /* 이미 멈춤 */ }
      }
    }

    return {
      configure(next) {
        cfg = next || {}
      },
      setVisible(next) {
        visible = !!next
        if (!visible) stop()
      },
      play,
      /** 설정 창의 '듣기' 버튼용: 스위치와 상관없이 지금 볼륨으로 한 번. */
      preview(name) {
        play(name, { force: true })
      },
      allowed,
      stop,
    }
  }

  const api = { create, FILES }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.ChatSound = api
})(typeof window === 'undefined' ? globalThis : window)
