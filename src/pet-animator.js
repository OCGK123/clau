// 몸짓 엔진(PetAnimator): 상태별 움직임을 매 프레임 계산하고, 상태가 바뀌면 지금 모습에서 새 움직임으로 부드럽게 넘어간다.
// CSS 키프레임은 클래스가 바뀌는 순간 0% 프레임으로 툭 튀어서, 쓰다듬다 웃을 때 끊겨 보였다.
// pet-motion.js(집어 들었을 때의 진자 운동)와는 별개다. 이쪽은 상태별 몸짓을 맡고, 몸(.body)을 감싸는
// .mover에 transform을 준다. 그래서 진자 회전·boing과 겹쳐도 서로 덮어쓰지 않고 합쳐진다.
;(function (root) {
const PetAnimator = (() => {
  const BLEND_MS = 170 // 상태가 바뀔 때 앞 움직임에서 새 움직임으로 섞는 시간(짧을수록 반응이 빠르다)
  // 찰짐 세기: 모든 눌림·늘어남·뜀의 크기를 한꺼번에 키우거나 줄인다. 1 = 원래 값.
  const JUICE = 1.4
  const TAU = Math.PI * 2
  const ID = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 }
  const SQUISH_S = 0.52 // 쓰다듬기 말랑 한 주기(초)

  const easeOut = p => 1 - (1 - p) ** 3
  const smooth = p => p * p * (3 - 2 * p)
  /** 0→1→0 을 매끈하게 오가는 파동 (CSS alternate + ease-in-out 과 같은 모양). */
  const wave = (t, period) => (1 - Math.cos((TAU * t) / period)) / 2
  /** [위치, 값] 키프레임 사이를 smoothstep으로 잇는다. p는 0~1. */
  function keys(p, frames) {
    for (let i = 1; i < frames.length; i++) {
      const [p1, v1] = frames[i]
      const [p0, v0] = frames[i - 1]
      if (p <= p1) {
        const k = smooth((p - p0) / (p1 - p0 || 1))
        return v0.map((v, j) => v + (v1[j] - v) * k)
      }
    }
    return frames[frames.length - 1][1]
  }

  /** 뛰어올랐다 내려오는 높이(0~1). 정점이 40% 지점이라 올라갈 땐 빠르고 내려올 땐 느긋하다. */
  function arc(p) {
    const q = p < 0.4 ? (p / 0.4) * 0.5 : 0.5 + ((p - 0.4) / 0.6) * 0.5
    return Math.sin(Math.PI * q)
  }
  /** 착지 순간 살짝 눌렸다 펴지는 정도. 마지막 착지 이후 dt초. */
  // sin으로 시작해 0에서 출발한다: 착지 순간 값이 툭 바뀌지 않는다.
  const landing = dt => (dt >= 0 ? Math.exp(-dt / 0.1) * Math.sin(dt * 20) * 1.3 : 0)

  // 상태별 몸(body) 움직임. t = 상태가 시작된 뒤 지난 초, u = 캐릭터 높이의 1%(px).
  const BODY = {
    // 가만히 있을 때: 세로로 늘었다(들숨) 눌렸다(날숨)를 한 번의 매끈한 파도로 오간다.
    // 예전엔 들숨 끝에 작은 반동을 넣었는데, 가만히 있을 때 혼자 움찔 튀는 것처럼 보여서 뺐다.
    idle: t => {
      const w = Math.sin((TAU * t) / 3.2) // -1 ~ 1, 3.2초 한 호흡
      return { ...ID, sx: 1 - 0.007 * w, sy: 1 + 0.016 * w }
    },
    talking: (t, u) => {
      const w = wave(t, 0.68)
      return { ...ID, ty: -0.9 * u * w, sx: 1 - 0.008 * w, sy: 1 + 0.014 * w }
    },
    happy: (t, u) => {
      const JUMP = 0.45
      const COUNT = 2
      const n = Math.floor(t / JUMP)
      if (n >= COUNT) {
        const sq = 0.06 * landing(t - COUNT * JUMP)
        return { ...ID, sx: 1 + sq * 0.6, sy: 1 - sq }
      }
      const p = (t % JUMP) / JUMP
      const h = arc(p)
      const land = n > 0 ? 0.06 * landing(t - n * JUMP) : 0
      // 뛰기 직전 살짝 웅크린다(0에서 시작해 0으로: 이음매 없음).
      // 두 번째부터는 착지 눌림이 곧 다음 도약의 웅크림이라 겹쳐 더하지 않는다.
      const crouch = n === 0 && p < 0.14 ? 0.05 * Math.sin((Math.PI * p) / 0.14) * Math.min(1, t / 0.04) : 0
      const air = 0.045 * h // 공중에선 세로로 쭉
      const sq = land + crouch - air
      return { ...ID, ty: -3.8 * u * h, sx: 1 + sq * 0.6, sy: 1 - sq }
    },
    // 부르르: 처음엔 크게, 점점 잦아든다.
    oops: (t, u) => {
      const DUR = 0.72
      if (t >= DUR) return ID
      return { ...ID, tx: 1.2 * u * Math.sin((TAU * t) / 0.09) * (1 - t / DUR) }
    },
    petted: t => {
      const [sx, sy] = keys((t % SQUISH_S) / SQUISH_S, [
        [0, [1, 1]],
        [0.28, [1.05, 0.925]],
        [0.58, [0.972, 1.032]],
        [0.8, [1.014, 0.984]],
        [1, [1, 1]],
      ])
      return { ...ID, sx, sy }
    },
    // 손을 뗀 직후: 말랑 주기가 끝난 (1, 1)에서 그대로 이어진다.
    // sin으로 시작하니 첫 프레임 값이 0이고, 쭉 펴지며 살짝 떴다가 감쇠 진동으로 가라앉는다.
    pleased: (t, u) => {
      const a = -0.055 * Math.exp(-t / 0.2) * Math.sin(t * 15)
      const lift = t < 0.32 ? -1.6 * u * Math.sin((Math.PI * t) / 0.32) : 0
      return { ...ID, ty: lift, sx: 1 + a * 0.7, sy: 1 - a }
    },
    dozing: t => {
      const b = 0.012 * wave(t, 5)
      return { ...ID, sx: 1 + b, sy: 1 - b }
    },
    sleeping: t => {
      const b = 0.012 * wave(t, 4)
      return { ...ID, sx: 1 + b, sy: 1 - b }
    },
  }

  // 상태별 작은 친구(buddy) 그림 움직임. 바깥 상자의 둥실거림은 CSS가 계속 맡고,
  // 여기서는 주인과 같은 박자로 말랑하게 눌리고 늘어나고 뛴다. 몸집이 작아서 주인보다 과장되게.
  /**
   * 통통 뛰기: 공중에선 세로로 살짝 늘어나고, 땅에 닿기 직전·직후엔 납작하게 눌린다.
   * 눌림은 착지 순간을 중심으로 앞뒤가 대칭이라 주기가 바뀌는 지점에서도 값이 이어진다.
   */
  function hop(t, u, period, height = 4, count = 0) {
    if (count && t >= period * count) {
      // 마지막 착지 뒤: 눌린 채로 멈추지 않고 착지 눌림이 자연스럽게 풀린다.
      const sq = 0.1 * Math.max(0, 1 - (t - period * count) / 0.07) ** 2
      return { ...ID, sx: 1 + sq * 0.8, sy: 1 - sq }
    }
    const p = (t % period) / period
    const h = arc(p)
    const d = Math.min(p, 1 - p) * period // 가장 가까운 착지까지 남은(지난) 초
    // 첫 도약은 0에서 눌리기 시작한다(상태가 바뀌자마자 납작해져 툭 튀지 않게).
    const ramp = t < period / 2 ? Math.min(1, t / 0.06) : 1
    const sq = 0.1 * ramp * Math.max(0, 1 - d / 0.07) ** 2
    const stretch = 0.05 * h
    return { ...ID, ty: -height * u * h, sx: 1 - stretch * 0.6 + sq * 0.8, sy: 1 + stretch - sq }
  }
  /** 제자리 말랑: 숨쉬듯 세로로 늘었다 눌렸다. 주인보다 반 박자 늦게(phase) 따라 한다. */
  function squishLoop(t, period, amp, phase = 0) {
    const w = Math.sin((TAU * (t / period + phase)))
    return { ...ID, sx: 1 - amp * 0.6 * w, sy: 1 + amp * w }
  }
  const BUDDY = {
    // 주인 호흡(3.2초)과 같은 박자로, 반 박자 늦게 말랑. 위아래로 뜨지는 않는다(혼자 튀어 보이지 않게).
    idle: t => squishLoop(t, 3.2, 0.035, -0.12),
    thinking: t => ({ ...squishLoop(t, 3.2, 0.025), rot: 6 * Math.sin((TAU * t) / 2.4) }),
    talking: (t, u) => hop(t, u, 0.36, 1.6),
    working: (t, u) => hop(t, u, 0.5, 4),
    happy: (t, u) => hop(t, u, 0.4, 5, 4),
    petted: (t, u) => hop(t, u, 0.28, 3.2), // 주인이 쓰다듬어지면 옆에서 신나서 콩콩
    pleased: (t, u) => hop(t, u, 0.42, 4.5, 1),
    oops: t => (t >= 0.9 ? ID : { ...ID, rot: -12 * wave(t, 0.3) }),
    dozing: t => squishLoop(t, 5, 0.03),
    sleeping: t => squishLoop(t, 4, 0.035),
  }


  // 상태가 바뀌는 순간 몸이 한 번 "꿀렁": 눌렸다 늘어나며 새 상태로 들어간다. 값은 세기.
  const ENTRY = { idle: 0.022, thinking: 0.026, talking: 0.024, working: 0.03, happy: 0.045, oops: 0.04, sleeping: 0.014 }
  const entryKick = amp => t => {
    const a = amp * Math.exp(-t / 0.16) * Math.sin(t * 17)
    return { ...ID, sx: 1 + a * 0.75, sy: 1 - a }
  }

  const now = () => performance.now()
  const mix = (a, b, k) => {
    const o = {}
    for (const key in ID) o[key] = a[key] + (b[key] - a[key]) * k
    return o
  }
  const isRest = v => Math.abs(v.tx) + Math.abs(v.ty) + Math.abs(v.sx - 1) + Math.abs(v.sy - 1) + Math.abs(v.rot) < 1e-4
  /** 기본 모양(ID)에서 벗어난 정도를 JUICE배로 키운다. */
  const juice = v => ({ tx: v.tx * JUICE, ty: v.ty * JUICE, sx: 1 + (v.sx - 1) * JUICE, sy: 1 + (v.sy - 1) * JUICE, rot: v.rot })
  const css = v =>
    isRest(v)
      ? ''
      : `translate(${v.tx.toFixed(2)}px, ${v.ty.toFixed(2)}px) rotate(${v.rot.toFixed(2)}deg) scale(${v.sx.toFixed(4)}, ${v.sy.toFixed(4)})`

  /** 한 요소의 움직임 트랙: 지금 상태의 움직임 + 바뀔 때 섞기 + 덧붙는 짧은 충격. */
  function track(node, table) {
    return {
      node,
      table,
      fn: null,
      start: now(),
      from: ID,
      blendStart: -Infinity,
      blendMs: BLEND_MS,
      last: ID,
      kicks: [],
    }
  }

  let tracks = []
  let mode = 'idle'
  let unit = 2
  let calm = false
  let raf = 0

  function sample(tr, at) {
    const t = (at - tr.start) / 1000
    let v = tr.fn ? tr.fn(t, unit) : ID
    const k = (at - tr.blendStart) / tr.blendMs
    if (k < 1) v = mix(tr.from, v, easeOut(Math.max(0, k)))
    tr.kicks = tr.kicks.filter(kick => at - kick.start < kick.ms)
    for (const kick of tr.kicks) {
      const add = kick.fn((at - kick.start) / 1000, unit)
      v = { tx: v.tx + add.tx, ty: v.ty + add.ty, sx: v.sx * add.sx, sy: v.sy * add.sy, rot: v.rot + add.rot }
    }
    return v
  }

  /** 움직임이 끝났고(고정 상태 + 섞기 끝 + 충격 없음) 더 그릴 게 없으면 루프를 멈춘다. CPU 아끼기. */
  function settled(tr, at) {
    if (tr.kicks.length || at - tr.blendStart < tr.blendMs) return false
    return !tr.fn || isRest(tr.fn((at - tr.start) / 1000, unit))
  }

  const SLOW = new Set(['idle', 'dozing', 'sleeping']) // 숨쉬기처럼 느린 동작
  let skip = false
  /** 섞기·충격 없이 느린 숨쉬기만 남았는가 → 한 프레임씩 건너뛰어도 눈으로 차이가 없다. */
  const calmOnly = at => SLOW.has(mode) && tracks.every(tr => !tr.kicks.length && at - tr.blendStart >= tr.blendMs)

  function frame() {
    raf = 0
    const at = now()
    skip = calmOnly(at) && !skip
    if (skip) {
      raf = requestAnimationFrame(frame)
      return
    }
    let busy = false
    for (const tr of tracks) {
      const v = sample(tr, at)
      tr.last = v
      tr.node.style.transform = css(juice(v))
      if (!settled(tr, at)) busy = true
    }
    if (busy && !paused) raf = requestAnimationFrame(frame)
  }
  const wakeLoop = () => {
    if (!raf && !calm && !paused) raf = requestAnimationFrame(frame)
  }

  let paused = false

  return {
    /** 창이 숨겨지면 루프를 멈추고, 다시 보이면 지금 상태에서 이어 간다(백그라운드 전력 절약). */
    setPaused(on) {
      paused = !!on
      if (paused) {
        cancelAnimationFrame(raf)
        raf = 0
      } else wakeLoop()
    },
    /** body, buddy 그림 요소를 등록한다. buddy가 없으면 null. */
    attach(bodyNode, buddyNode) {
      tracks = [track(bodyNode, BODY)]
      if (buddyNode) tracks.push(track(buddyNode, BUDDY))
      this.setMode(mode, true) // 등록 전에 바뀐 상태도 반영
    },
    setUnit(px) {
      unit = px
    },
    setCalm(on) {
      calm = !!on
      if (calm) {
        cancelAnimationFrame(raf)
        raf = 0
        for (const tr of tracks) tr.node.style.transform = ''
      } else this.setMode(mode, true)
    },
    setMode(next, force = false) {
      if (next === mode && !force) return
      mode = next
      const at = now()
      for (const tr of tracks) {
        // 지금 화면에 보이는 모습에서 출발해야 툭 튀지 않는다.
        tr.from = tr.last
        tr.blendStart = at
        tr.blendMs = BLEND_MS
        tr.start = at
        tr.fn = tr.table[mode] ?? null
      }
      if (!force && ENTRY[mode]) {
        // 상태가 바뀔 때 주인과 작은 친구가 같이 꿀렁. 작은 친구는 1.8배 과장.
        tracks.forEach((tr, i) => tr.kicks.push({ fn: entryKick(ENTRY[mode] * (i ? 1.8 : 1)), ms: 420, start: at }))
      }
      wakeLoop()
    },
    /** 쓰다듬기 말랑 주기가 끝나 (1, 1)로 돌아올 때까지 남은 ms. 다른 상태면 0. */
    untilSquishEnd() {
      const tr = tracks[0]
      if (calm || !tr || mode !== 'petted') return 0
      const t = (now() - tr.start) / 1000
      return Math.round((SQUISH_S - (t % SQUISH_S)) * 1000)
    },
    /**
     * 연타: 칠 때마다 지금 동작을 처음(0초)부터 다시 시작한다.
     * 아주 짧게(RESTART_BLEND_MS) 이어 붙여서, 처음으로 돌아가되 한 프레임에 툭 끊기지는 않는다.
     */
    restart() {
      if (calm) return
      const RESTART_BLEND_MS = 45
      const at = now()
      for (const tr of tracks) {
        tr.from = tr.last
        tr.blendStart = at
        tr.blendMs = RESTART_BLEND_MS
        tr.start = at
        tr.kicks = []
      }
      // 맞는 순간 꾹: 위에서 누른 듯 납작해졌다 튕겨 오른다.
      const punch = t => {
        const a = 0.035 * Math.exp(-t / 0.08) * Math.sin(t * 26)
        return { ...ID, sx: 1 + a * 0.8, sy: 1 - a }
      }
      tracks[0]?.kicks.push({ fn: punch, ms: 300, start: at })
      wakeLoop()
    },
    /** 지금 동작 위에 짧게 한 번 통통 튀는 충격을 얹는다(말풍선이 열릴 때 등). */
    bounce(amp = 0.03) {
      if (calm || !tracks[0]) return
      tracks[0].kicks.push({ fn: entryKick(amp), ms: 420, start: now() })
      wakeLoop()
    },
    /** 지금 움직임 위에 짧은 충격을 얹는다(예: 깜빡일 때 몸이 살짝 출렁). */
    kick(fn, ms) {
      if (calm || !tracks[0]) return
      tracks[0].kicks.push({ fn, ms, start: now() })
      wakeLoop()
    },
    ID,
  }
})()
  if (typeof module !== 'undefined' && module.exports) module.exports = PetAnimator
  else root.PetAnimator = PetAnimator
})(typeof window === 'undefined' ? globalThis : window)
